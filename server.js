// yt-web — เว็บหน้าเดียวสำหรับโหลดเสียง/วิดีโอ YouTube ผ่าน yt-dlp
// zero-dependency Node http server
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 6200;
const ROOT = __dirname;
const JOBS_DIR = path.join(os.tmpdir(), 'yt-web-jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const jobs = {}; // id -> { proc, percent, phase, status, file, error }

// ---- เช็คว่ามี yt-dlp / ffmpeg ในเครื่องไหม ----
function checkBin(cmd, arg) {
  return new Promise((resolve) => {
    const p = spawn(cmd, [arg], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => out += d);
    p.on('error', () => resolve({ ok: false, version: '' }));
    p.on('close', (code) => resolve({ ok: code === 0, version: out.trim().split('\n')[0] }));
  });
}
async function checkDeps() {
  const [ytdlp, ffmpeg] = await Promise.all([
    checkBin('yt-dlp', '--version'),
    checkBin('ffmpeg', '-version'),
  ]);
  return { ytdlp, ffmpeg };
}

// อนุญาตเฉพาะ URL ที่หน้าตาเป็นลิงก์เว็บจริง ป้องกัน argument injection
function validUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch { return false; }
}

const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'wav', 'flac'];
const VIDEO_CONTAINERS = ['mp4', 'webm', 'mkv'];
const QUALITIES = { best: 0, '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480, '360': 360 };

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180);
}

// รูปแบบเวลาที่ยอมรับ: 90 / 1:30 / 1:02:03 / 1:30.5
function validTime(t) {
  return typeof t === 'string' && /^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t);
}

// สร้าง arg ตัดเฉพาะช่วง ถ้ามี start/end ที่ถูกต้อง
function buildSection(opts) {
  const s = (opts.start || '').trim(), e = (opts.end || '').trim();
  if (!s && !e) return [];
  if ((s && !validTime(s)) || (e && !validTime(e))) return [];
  return ['--download-sections', `*${s || '0'}-${e || 'inf'}`];
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// ---- ดึงข้อมูลคลิป ----
function fetchInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['-J', '--no-playlist', '--no-warnings', url];
    const p = spawn('yt-dlp', args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d);
    p.stderr.on('data', (d) => err += d);
    p.on('error', (e) => reject(new Error('เรียก yt-dlp ไม่ได้: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || 'ดึงข้อมูลไม่สำเร็จ'));
      try {
        const j = JSON.parse(out);
        resolve({
          title: j.title,
          uploader: j.uploader || j.channel || '',
          duration: j.duration || 0,
          thumbnail: j.thumbnail || '',
          extractor: j.extractor_key || '',
        });
      } catch (e) { reject(new Error('อ่านข้อมูลไม่ได้')); }
    });
  });
}

// ---- เริ่มงานโหลด ----
function startJob(opts) {
  const id = Date.now().toString(36) + Math.floor(performance.now() % 1e6).toString(36);
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const tmpl = path.join(dir, '%(title)s.%(ext)s');

  const section = buildSection(opts);
  let args;
  if (opts.type === 'audio') {
    const fmt = AUDIO_FORMATS.includes(opts.format) ? opts.format : 'mp3';
    // เสียง: re-encode อยู่แล้ว → ใส่ --force-keyframes-at-cuts ให้ตัดตรงเวลาเป๊ะ (เร็ว)
    const kf = section.length ? ['--force-keyframes-at-cuts'] : [];
    args = ['-x', '--audio-format', fmt, '--audio-quality', '0', ...section, ...kf,
      '--no-playlist', '--newline', '--no-warnings', '-o', tmpl, opts.url];
  } else {
    const cont = VIDEO_CONTAINERS.includes(opts.format) ? opts.format : 'mp4';
    const h = QUALITIES[opts.quality] || 0;
    const sel = h
      ? `bv*[height<=${h}]+ba/b[height<=${h}]`
      : 'bv*+ba/b';
    // วิดีโอ + ตัดช่วง: ห้าม re-encode (1080p60 ช้าเป็นนาที) → ตัดที่ keyframe แบบ copy (เร็ว)
    // เลือก H.264 ก่อน เพื่อ copy เข้า mp4 ได้สะอาดและเล่นได้ทุกที่ (ถ้าไม่มีค่อย fallback AV1/VP9)
    const vsort = section.length ? ['-S', 'vcodec:h264'] : [];
    args = ['-f', sel, ...vsort, '--merge-output-format', cont, ...section,
      '--no-playlist', '--newline', '--no-warnings', '-o', tmpl, opts.url];
  }

  const job = { percent: 0, phase: 'เริ่มต้น...', status: 'running', file: null, error: null };
  jobs[id] = job;

  const p = spawn('yt-dlp', args, { windowsHide: true });
  job.proc = p;
  const onLine = (buf) => {
    const s = buf.toString();
    const m = s.match(/\[download\]\s+([\d.]+)%/);
    if (m) { job.percent = parseFloat(m[1]); job.phase = 'กำลังดาวน์โหลด'; }
    if (/\[ExtractAudio\]/.test(s)) job.phase = 'แปลงเสียง';
    if (/\[Merger\]/.test(s)) job.phase = 'รวมไฟล์';
    if (/\[VideoConvertor\]|\[Recode\]/.test(s)) job.phase = 'แปลงไฟล์';
  };
  p.stdout.on('data', onLine);
  p.stderr.on('data', (d) => { onLine(d); job._err = (job._err || '') + d; });
  p.on('error', (e) => { job.status = 'error'; job.error = 'เรียก yt-dlp ไม่ได้: ' + e.message; });
  p.on('close', (code) => {
    if (job.status === 'error') return;
    if (code !== 0) {
      job.status = 'error';
      job.error = ((job._err || '').trim().split('\n').pop()) || ('yt-dlp ออกด้วยรหัส ' + code);
      return;
    }
    const files = fs.readdirSync(dir).map((f) => ({ f, s: fs.statSync(path.join(dir, f)).size }));
    if (!files.length) { job.status = 'error'; job.error = 'ไม่พบไฟล์ที่โหลด'; return; }
    files.sort((a, b) => b.s - a.s);
    job.file = path.join(dir, files[0].f);
    job.percent = 100;
    job.phase = 'เสร็จแล้ว';
    job.status = 'done';
  });

  return id;
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // อนุญาตให้หน้าเว็บที่โฮสต์ที่อื่น (เช่น GitHub Pages) เรียกโปรแกรมในเครื่องนี้ได้
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204); res.end(); return;
  }

  if (p === '/' || p === '/index.html') {
    return fs.createReadStream(path.join(ROOT, 'public', 'index.html'))
      .on('error', () => { res.writeHead(404); res.end(); })
      .pipe(res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }) || res);
  }

  if (p === '/api/health') {
    return json(res, 200, await checkDeps());
  }

  if (p === '/api/info') {
    const url = u.searchParams.get('url');
    if (!validUrl(url)) return json(res, 400, { error: 'URL ไม่ถูกต้อง' });
    try { return json(res, 200, await fetchInfo(url)); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (p === '/api/start' && req.method === 'POST') {
    const b = await readBody(req);
    if (!validUrl(b.url)) return json(res, 400, { error: 'URL ไม่ถูกต้อง' });
    if (b.type !== 'audio' && b.type !== 'video') return json(res, 400, { error: 'ชนิดไฟล์ไม่ถูกต้อง' });
    const id = startJob(b);
    return json(res, 200, { jobId: id });
  }

  if (p.startsWith('/api/status/')) {
    const id = p.split('/').pop();
    const job = jobs[id];
    if (!job) return json(res, 404, { error: 'ไม่พบงาน' });
    return json(res, 200, { percent: job.percent, phase: job.phase, status: job.status, error: job.error });
  }

  if (p.startsWith('/api/progress/')) {
    const id = p.split('/').pop();
    const job = jobs[id];
    if (!job) return json(res, 404, { error: 'ไม่พบงาน' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const tick = setInterval(() => {
      res.write(`data: ${JSON.stringify({ percent: job.percent, phase: job.phase, status: job.status, error: job.error })}\n\n`);
      if (job.status === 'done' || job.status === 'error') { clearInterval(tick); res.end(); }
    }, 400);
    req.on('close', () => clearInterval(tick));
    return;
  }

  if (p.startsWith('/api/file/')) {
    const id = p.split('/').pop();
    const job = jobs[id];
    if (!job || job.status !== 'done' || !job.file) return json(res, 404, { error: 'ไฟล์ยังไม่พร้อม' });
    const fname = sanitize(path.basename(job.file));
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(job.file).size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    });
    fs.createReadStream(job.file).pipe(res);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`yt-web ทำงานที่ http://localhost:${PORT}`);
});
