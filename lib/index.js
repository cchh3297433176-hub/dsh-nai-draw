// dsh-go 本地生图插件：酸薄荷 NovelAI 中转，只走 4.5。
// 输入框写描述 → 点「画图」胶囊出图；作品看画廊，画师串可切换。
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data');
const GEN = path.join(ROOT, 'assets', 'gen');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const PRESETS_FILE = path.join(DATA, 'presets.json');
const LEGACY_ARTISTS = path.join(DATA, 'artists.json');
// 手机直连中转站约 60% 的 TCP 连接被丢，默认走腾讯云的 /nai/ 反代（稳定）；
// 反代整条不通时再退回直连。可在 data/settings.json 里用 baseUrl 覆盖。
const API_BASE = 'https://xiaowanzi.top/nai/api/openai/v1';
const FALLBACK_BASE = 'https://create.suanbohe.com/api/openai/v1';
const PKG = 'local-nai-draw';

const NEGATIVE = 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page';
const MODELS = [
  { id: 'nai-diffusion-4-5-curated', label: '4.5 Curated', quality: 'location, masterpiece, no text, -0.8::feet::' },
  { id: 'nai-diffusion-4-5-full', label: '4.5 Full', quality: 'location, very aesthetic, masterpiece, no text' },
];
const SIZES = ['832x1216', '1216x832', '1024x1024'];
const STEPS = [28, 20, 14];
const DIRECTOR = '【剧情配图】用户要求配图或按剧情画时，调用 nai_draw。写 prompt 前先定：在场人物与动作（只取对话事实，不编人、不编事）、景别（close-up / upper body / medium shot / full body / wide shot 只选一个，且框住核心动作）、光线时间、色调氛围。tag 用英文 danbooru 小写逗号串，顺序：人数 → 景别 → 同人身份 tag（character name (copyright name)）→ 外貌 → 服饰 → 动作 → 表情视线 → 场景 → 光线；每人各写表情和视线；多人时把服装、动作、表情绑到具体角色（white dress on silver hair girl）；地形天气没依据不写；不写质量词、画师串、负面词（插件补）；40 个 tag 内。';
const AUTO = '【自动配图已开】每轮回复后，如果剧情出现值得画的画面，调用 nai_draw 画一张，每轮最多一张。';

const DEFAULTS = {
  model: 'nai-diffusion-4-5-curated',
  size: '832x1216',
  steps: 28,
  sampler: 'k_euler_ancestral',
  rating: 'off',
  autoDraw: false,
  activeArtist: 'u1',
  key: '',
};

// 插件资源走 GET /dsh-go/v1/assets/<pkg>/<path>，桥接层超过 1 MiB 直接 404（App 里就是
// 一张破图）。所以生成的图统一压到 1 MiB 以下，转换失败才退回原 PNG。
const MAX_ASSET_BYTES = 1048576;
const WEBP_TARGET_BYTES = 1000000;
const RETRY_DELAYS = [300, 700, 1200, 2000, 3000, 4000];
const ATTEMPT_MS = 5000;
const POST_MS = 150000;

const PY_WEBP = `
import io, sys
from PIL import Image
src, dst, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
for scale in (1.0, 0.875, 0.75, 0.625, 0.5):
    w, h = max(1, round(im.width * scale)), max(1, round(im.height * scale))
    frame = im if scale == 1.0 else im.resize((w, h), Image.LANCZOS)
    for q in (86, 78, 70, 62, 54):
        buf = io.BytesIO()
        frame.save(buf, 'WEBP', quality=q, method=6)
        if buf.tell() <= limit:
            open(dst, 'wb').write(buf.getvalue())
            print(buf.tell())
            raise SystemExit(0)
raise SystemExit(1)
`;

/** Network-level failures only: a 4xx/5xx answer must not be retried. */
function isTransient(error) {
  const message = String(error?.message ?? '');
  const code = String(error?.cause?.code ?? error?.code ?? '');
  if (error?.name === 'AbortError') return true; // our own per-attempt timeout
  if (message.includes('fetch failed')) return true;
  return ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}

/**
 * Retry a request that died before the server answered. The relay drops most
 * connections from this network, so each attempt gets its own 5s deadline and
 * the loop keeps trying until the budget runs out or the user cancels.
 */
async function withRetry(run, signal, attemptMs = ATTEMPT_MS) {
  let last;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (signal?.aborted) throw new Error('已取消');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await run(controller.signal);
    } catch (error) {
      last = error;
      if (signal?.aborted) throw new Error('已取消');
      if (attempt === RETRY_DELAYS.length || !isTransient(error)) break;
      await new Promise((resolve) => {
        const wait = setTimeout(resolve, RETRY_DELAYS[attempt]);
        signal?.addEventListener('abort', () => { clearTimeout(wait); resolve(); }, { once: true });
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw isTransient(last) ? new Error('中转站连不上（重试多次）') : last;
}


/**
 * Warm one connection before the slow request: the relay drops most new
 * connections from this network, but the image request itself takes tens of
 * seconds, so it cannot be bounded by the short connect deadline.
 */
async function warmup(base, key, signal) {
  try {
    await withRetry((attempt) => fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: attempt,
    }), signal);
  } catch {
    // The image request still gets its own attempt and reports the real failure.
  }
}

/** width/height of a `WxH` size string, for the image component. */
function aspectOf(size) {
  const [w, h] = String(size ?? '').split('x').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && h > 0 ? Math.min(4, Math.max(0.25, w / h)) : 1;
}


// 工具卡里的 asset: 取不到资源（同一张图在作品面板里能用），卡片还有个 8 KiB
// 的预算，所以卡片用一张 192px 的内嵌缩略图，完整图仍在回复和作品里。
const PY_THUMB = `
import io, sys
from PIL import Image
src, dst, target = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
for px in (192, 160, 128):
    ratio = min(1.0, px / max(im.width, im.height))
    frame = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
    for q in (58, 50, 42, 34):
        buf = io.BytesIO()
        frame.save(buf, 'WEBP', quality=q, method=6)
        if buf.tell() <= target:
            open(dst, 'wb').write(buf.getvalue())
            raise SystemExit(0)
raise SystemExit(1)
`;

/** An inline `data:` preview small enough for the 8 KiB tool-card budget. */
function thumbDataUrl(src) {
  const dst = path.join(GEN, `.thumb-${process.pid}-${Date.now()}.webp`);
  try {
    const result = spawnSync('python3', ['-c', PY_THUMB, src, dst, '4200'], { encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) return undefined;
    const bytes = readFileSync(dst);
    return bytes.length > 0 && bytes.length <= 4400 ? `data:image/webp;base64,${bytes.toString('base64')}` : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rm(dst, { force: true }).catch(() => {});
  }
}

/** Shrink one PNG to a WebP under the asset limit; undefined when no encoder is available. */
function toWebp(pngPath, webpPath) {
  try {
    const result = spawnSync('python3', ['-c', PY_WEBP, pngPath, webpPath, String(WEBP_TARGET_BYTES)], { encoding: 'utf8', timeout: 90000 });
    if (result.status !== 0) return undefined;
    const bytes = Number(String(result.stdout).trim());
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function settings() {
  const raw = await readJson(SETTINGS_FILE, {});
  return { ...DEFAULTS, ...raw };
}

async function saveSettings(patch) {
  const next = { ...(await settings()), ...patch };
  await writeJson(SETTINGS_FILE, next);
  return next;
}

async function presets() {
  let list = await readJson(PRESETS_FILE, null);
  if (!Array.isArray(list) || !list.length) list = await readJson(LEGACY_ARTISTS, []);
  if (!Array.isArray(list)) return [];
  return list.map(p => ({
    id: String(p.id ?? ''),
    name: String(p.name ?? '未命名'),
    prompt: String(p.prompt ?? ''),
    quality: String(p.quality ?? ''),
    negative: String(p.negative ?? ''),
    ...(p.size ? { size: String(p.size) } : {}),
    ...(p.steps ? { steps: Number(p.steps) } : {}),
  })).filter(p => p.id);
}

function modelInfo(id) {
  return MODELS.find(m => m.id === id) ?? MODELS[0];
}

function qualityFor(preset, rating, model) {
  const base = preset?.quality?.trim() || modelInfo(model).quality;
  return rating === 'general' ? `${base}, rating:general` : base;
}

function promptFor(preset, draft, rating, model) {
  return [preset?.prompt, draft, qualityFor(preset, rating, model)].filter(Boolean).join(', ').replace(/,\s*,/g, ', ');
}

async function recent(limit = 24) {
  let names = [];
  try {
    names = (await fs.readdir(GEN)).filter(name => /\.(png|webp|jpe?g)$/i.test(name));
  } catch {
    return [];
  }
  names.sort((a, b) => b.localeCompare(a));
  const items = [];
  for (const name of names.slice(0, limit)) {
    const id = name.replace(/\.(png|webp|jpe?g)$/i, '');
    const meta = await readJson(path.join(GEN, `${id}.json`), {});
    items.push({
      src: `asset:gen/${name}`,
      alt: meta.prompt ? meta.prompt.slice(0, 80) : name,
      caption: meta.prompt ? meta.prompt.slice(0, 40) : '',
    });
  }
  return items;
}

async function shoot(prompt, signal, overrides = {}) {
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const s = { ...(await settings()), ...clean };
  if (!s.key) throw new Error('还没配 Key');
  const list = await presets();
  const preset = list.find(a => a.id === s.activeArtist) ?? list[0];
  const seed = crypto.randomInt(0, 2 ** 31 - 1);
  const size = preset?.size ?? s.size;
  const steps = preset?.steps ?? s.steps;
  const body = {
    model: s.model,
    prompt: promptFor(preset, prompt, s.rating, s.model),
    negative_prompt: preset?.negative?.trim() || NEGATIVE,
    n: 1,
    size,
    steps,
    sampler: s.sampler,
    seed,
  };
  const bases = [typeof s.baseUrl === 'string' && s.baseUrl.trim() ? s.baseUrl.trim() : API_BASE, FALLBACK_BASE]
    .filter((value, index, all) => value !== '' && all.indexOf(value) === index);
  let res;
  let text = '';
  for (const base of bases) {
    try {
      await warmup(base, s.key, signal);
      res = await withRetry((attempt) => fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: attempt,
      }), signal, POST_MS);
      text = await res.text();
      break;
    } catch (error) {
      if (base === bases[bases.length - 1]) throw error;
    }
  }
  if (res.status !== 200) {
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text).error?.message ?? msg; } catch {}
    throw new Error(String(msg).slice(0, 38));
  }
  const url = JSON.parse(text)?.data?.[0]?.url;
  if (!url) throw new Error('没拿到图片地址');
  const buf = await withRetry(async (attempt) => {
    const img = await fetch(url, { signal: attempt });
    if (!img.ok) throw new Error(`下载失败 ${img.status}`);
    const bytes = Buffer.from(await img.arrayBuffer());
    if (bytes.length < 2048 || bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('图片不完整');
    return bytes;
  }, signal);
  await fs.mkdir(GEN, { recursive: true });
  const id = `${Date.now()}-${seed}`;
  const pngPath = path.join(GEN, `${id}.png`);
  await fs.writeFile(pngPath, buf);
  // 桥接层 >1 MiB 的资源会被 404，所以大图转成 WebP 再存。
  let name = `${id}.png`;
  if (buf.length > MAX_ASSET_BYTES) {
    const webpPath = path.join(GEN, `${id}.webp`);
    if (toWebp(pngPath, webpPath) !== undefined) {
      await fs.rm(pngPath, { force: true });
      name = `${id}.webp`;
    }
  }
  await writeJson(path.join(GEN, `${id}.json`), {
    prompt: body.prompt,
    draft: prompt,
    artist: preset?.name ?? '',
    model: s.model,
    size,
    steps,
    sampler: s.sampler,
    rating: s.rating,
    seed,
    createdAt: new Date().toISOString(),
  });
  const saved = await fs.stat(path.join(GEN, name));
  return { seed, bytes: saved.size, id, name, file: path.join(GEN, name), size, steps, artist: preset?.name ?? '' };
}

export const name = 'local-nai-draw';

export function apply(ctx) {
  ctx.inject(['systemPrompt'], (ctx) => {
    let auto = false;
    try { auto = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).autoDraw === true; } catch {}
    ctx.systemPrompt.section({
      name: 'local-nai-draw-director',
      order: 521,
      interpolate: false,
      text: DIRECTOR + (auto ? '\n' + AUTO : ''),
    });
  });

  ctx.inject(['tools'], (ctx) => {
    ctx.tools.register(defineTool({
      name: 'nai_draw',
      description: '用 NovelAI 4.5 按描述画一张图并直接展示。用户要求画图、改图，或要求根据对话/剧情配图时调用：先从上下文提炼画面，再把画面写成英文 tag 或短句。',
      parameters: {
        prompt: { type: 'string', required: true, description: '画面描述，英文 tag 或短句。' },
        size: { type: 'string', enum: SIZES, description: '尺寸，默认跟随设置。' },
        steps: { type: 'integer', enum: [14, 20, 24, 28], description: '步数，默认跟随设置。' },
        rating: { type: 'string', enum: ['off', 'general'], description: 'off 不限制；general 锁全年龄。' },
      },
      timeoutMs: 180_000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true }, view: { type: 'json', required: true } },
        },
        render: (args, value) => [{ type: 'text', text: value.text }],
        presentationMeta: (args, value) => ({ 'dsh-go/view': value.view }),
      },
      async execute(args, exec) {
        const out = await shoot(args.prompt, exec.signal, { size: args.size, steps: args.steps, rating: args.rating });
        const src = thumbDataUrl(out.file) ?? `asset:gen/${out.name}`;
        return {
          text: `已生成：${out.file}\nseed ${out.seed} · ${out.size} · ${out.steps} 步`,
          view: {
            v: 2,
            type: 'stack',
            title: '画好了',
            children: [
              { type: 'image', src, alt: String(args.prompt).slice(0, 80), aspect: aspectOf(out.size), caption: `seed ${out.seed}` },
              { type: 'keyValue', items: [['模型', 'NAI 4.5'], ['尺寸', out.size], ['步数', `${out.steps} 步`], ['画师串', out.artist], ['种子', String(out.seed)]] },
            ],
          },
        };
      },
    }));
  });

  ctx.inject(['dshGo'], (ctx) => {
    let busy = false;

    ctx.dshGo.on('draw', (scope) => {
      const draft = String(scope.draft ?? '').trim();
      if (!draft) return { toast: '先在输入框写一句描述' };
      if (busy) return { toast: '上一张还在画，稍等' };
      return {
        pending: { label: '正在画…', timeoutMs: 60_000 },
        result: async (signal) => {
          busy = true;
          try {
            const out = await shoot(draft, signal);
            return { toast: `画好了 · seed ${out.seed}` };
          } catch (e) {
            return { toast: String(e?.message ?? '画失败了').slice(0, 40) };
          } finally {
            busy = false;
          }
        },
      };
    });

    ctx.dshGo.panel('gallery', {
      view: () => ({
        v: 2,
        type: 'stack',
        title: '作品',
        children: [
          { type: 'text', text: '最近 24 张，点开看大图；保存用 App 自带按钮。', tone: 'muted' },
          { type: 'gallery', columns: 3, items: { $: 'data.items' } },
        ],
      }),
      data: async (scope, emit) => {
        emit({ items: await recent(24) });
        return () => {};
      },
      actions: {},
    });

    ctx.dshGo.panel('artists', {
      view: () => ({
        v: 2,
        type: 'stack',
        title: '画师串',
        children: [
          { type: 'text', text: '点一行切到这个预设，下一张就用它。', tone: 'muted' },
          { type: 'list', items: { $: 'data.items' } },
        ],
      }),
      data: async (scope, emit) => {
        const s = await settings();
        const list = await presets();
        emit({
          items: list.map(a => ({
            title: a.name,
            subtitle: [String(a.prompt ?? '').slice(0, 44), a.quality ? '自带质量词' : '', a.negative ? '自带负面词' : '', a.size ?? '', a.steps ? `${a.steps}步` : ''].filter(Boolean).join(' · '),
            trailing: a.id === s.activeArtist ? '使用中' : '',
            action: { id: 'use', args: { id: a.id } },
          })),
        });
        return () => {};
      },
      actions: {
        use: async (scope, event) => {
          const id = String(event.value?.id ?? '');
          if (!id) return { toast: '没找到这串' };
          await saveSettings({ activeArtist: id });
          return { refresh: true, toast: '已切换画师串' };
        },
      },
    });

    ctx.dshGo.panel('settings', {
      view: () => ({
        v: 2,
        type: 'stack',
        title: '生图设置',
        children: [
          { type: 'list', items: { $: 'data.rows' } },
        ],
      }),
      data: async (scope, emit) => {
        const s = await settings();
        const list = await presets();
        const artist = list.find(a => a.id === s.activeArtist);
        emit({
          rows: [
            { title: '模型', subtitle: '4.5 Curated / Full', trailing: modelInfo(s.model).label, action: 'cycle-model' },
            { title: '尺寸', trailing: s.size, action: 'cycle-size' },
            { title: '步数', trailing: `${s.steps} 步`, action: 'cycle-steps' },
            { title: '分级', trailing: s.rating === 'general' ? '全年龄' : '不限制', action: 'toggle-rating' },
            { title: '自动配图', trailing: s.autoDraw ? '开' : '关', action: 'toggle-auto' },
            { title: '预设', trailing: artist?.name ?? '—', action: 'open-artists' },
            { title: 'Key', trailing: s.key ? '已配置' : '未配置' },
          ],
        });
        return () => {};
      },
      actions: {
        'cycle-model': async () => {
          const s = await settings();
          const i = MODELS.findIndex(m => m.id === s.model);
          const next = MODELS[(i + 1) % MODELS.length];
          await saveSettings({ model: next.id });
          return { refresh: true, toast: next.label };
        },
        'toggle-rating': async () => {
          const s = await settings();
          await saveSettings({ rating: s.rating === 'general' ? 'off' : 'general' });
          return { refresh: true, toast: s.rating === 'general' ? '已放开分级' : '已锁全年龄' };
        },
        'toggle-auto': async () => {
          const s = await settings();
          await saveSettings({ autoDraw: !s.autoDraw });
          return { refresh: true, toast: s.autoDraw ? '自动配图已关' : '自动配图已开（重启后生效）' };
        },
        'cycle-size': async () => {
          const s = await settings();
          const i = SIZES.indexOf(s.size);
          const next = SIZES[(i + 1) % SIZES.length];
          await saveSettings({ size: next });
          return { refresh: true, toast: next };
        },
        'cycle-steps': async () => {
          const s = await settings();
          const i = STEPS.indexOf(Number(s.steps));
          const next = STEPS[(i + 1) % STEPS.length];
          await saveSettings({ steps: next });
          return { refresh: true, toast: `${next} 步` };
        },
        'open-artists': () => ({ open: 'panel:artists' }),
      },
    });
  });
}
