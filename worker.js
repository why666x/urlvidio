// ==========================================
//  Cloudflare Workers 视频管理器 + 管理后台
//  绑定 KV 变量名: VIDEO_KV
//  环境变量: ADMIN_PASSWORD (管理密码)
// ==========================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 路由分发
    try {
      // 公开播放页
      if (path === '/' || path === '/index.html') {
        return renderFrontPage();
      }

      // 管理后台
      if (path === '/admin') {
        // 鉴权
        const auth = checkAuth(request, env);
        if (auth) return auth;
        return renderAdminPage();
      }

      // API - 获取视频列表（公开）
      if (path === '/api/videos' && request.method === 'GET') {
        return jsonResponse(await getVideos(env));
      }

      // API - 添加视频（需鉴权）
      if (path === '/api/videos' && request.method === 'POST') {
        const auth = checkAuth(request, env);
        if (auth) return auth;
        const body = await request.json();
        return jsonResponse(await addVideo(env, body));
      }

      // API - 编辑视频（需鉴权）
      if (path.startsWith('/api/videos/') && request.method === 'PUT') {
        const auth = checkAuth(request, env);
        if (auth) return auth;
        const id = parseInt(path.split('/').pop());
        const body = await request.json();
        return jsonResponse(await updateVideo(env, id, body));
      }

      // API - 删除视频（需鉴权）
      if (path.startsWith('/api/videos/') && request.method === 'DELETE') {
        const auth = checkAuth(request, env);
        if (auth) return auth;
        const id = parseInt(path.split('/').pop());
        await deleteVideo(env, id);
        return jsonResponse({ success: true });
      }

      // 视频代理（解决跨域）
      if (path === '/proxy') {
        return proxyVideo(request, url);
      }

      // 404
      return new Response('Not Found', { status: 404 });

    } catch (e) {
      console.error(e);
      return new Response('Server Error: ' + e.message, { status: 500 });
    }
  }
};

// ==========================================
//  鉴权
// ==========================================
function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  const password = env.ADMIN_PASSWORD || 'admin123';

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Panel"',
        'Content-Type': 'text/plain'
      }
    });
  }

  const decoded = atob(authHeader.slice(6));
  const [user, pass] = decoded.split(':');

  if (pass !== password) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Panel"',
        'Content-Type': 'text/plain'
      }
    });
  }

  return null;
}

// ==========================================
//  KV 数据操作
// ==========================================
const KV_KEY = 'videos:list';

async function getVideos(env) {
  const data = await env.VIDEO_KV.get(KV_KEY, 'json');
  return data || [];
}

async function saveVideos(env, videos) {
  await env.VIDEO_KV.put(KV_KEY, JSON.stringify(videos));
}

async function addVideo(env, video) {
  const videos = await getVideos(env);
  const newId = videos.length > 0 ? Math.max(...videos.map(v => v.id)) + 1 : 1;
  const type = video.url.includes('.m3u8') ? 'm3u8' : 'mp4';
  
  const newVideo = {
    id: newId,
    name: video.name || '未命名视频',
    url: video.url,
    remark: video.remark || '',
    type: type,
    createdAt: Date.now()
  };

  videos.push(newVideo);
  await saveVideos(env, videos);
  return newVideo;
}

async function updateVideo(env, id, video) {
  const videos = await getVideos(env);
  const index = videos.findIndex(v => v.id === id);
  if (index === -1) throw new Error('Video not found');

  const type = video.url.includes('.m3u8') ? 'm3u8' : 'mp4';
  videos[index] = { ...videos[index], ...video, type };
  await saveVideos(env, videos);
  return videos[index];
}

async function deleteVideo(env, id) {
  const videos = await getVideos(env);
  const filtered = videos.filter(v => v.id !== id);
  await saveVideos(env, filtered);
}

// ==========================================
//  视频代理（解决跨域）
// ==========================================
async function proxyVideo(request, url) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return new Response('Missing url parameter', { status: 400 });

  // 构建请求，透传 Range 等关键头
  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  headers.set('User-Agent', 'Mozilla/5.0');

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      cf: { cacheTtl: 3600 }
    });

    // 构造响应，允许跨域
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Range');
    
    // 移除可能有问题的头
    newHeaders.delete('Content-Security-Policy');
    newHeaders.delete('X-Frame-Options');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}

// ==========================================
//  工具函数
// ==========================================
function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// ==========================================
//  前台播放页 HTML
// ==========================================
function renderFrontPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>视频播放器</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0f1115;
            color: #e6e6e6;
            height: 100vh; height: 100dvh;
            overflow: hidden;
        }
        .app { display: flex; height: 100vh; height: 100dvh; }
        
        /* 侧边栏 */
        .sidebar {
            width: 320px;
            background: #171a21;
            border-right: 1px solid #242831;
            display: flex; flex-direction: column;
            flex-shrink: 0;
        }
        .sidebar-header {
            padding: 16px;
            border-bottom: 1px solid #242831;
        }
        .sidebar-title {
            font-size: 16px; font-weight: 600;
            margin-bottom: 12px;
            display: flex; align-items: center; gap: 8px;
        }
        .search-box { position: relative; }
        .search-box input {
            width: 100%;
            padding: 10px 12px 10px 36px;
            background: #1f232c;
            border: 1px solid #2a2f3a;
            border-radius: 8px;
            color: #fff; font-size: 14px; outline: none;
        }
        .search-box::before {
            content: '🔍';
            position: absolute; left: 12px; top: 50%;
            transform: translateY(-50%);
            font-size: 14px; opacity: 0.6;
        }
        .file-list {
            flex: 1; overflow-y: auto;
            padding: 8px 0;
            -webkit-overflow-scrolling: touch;
        }
        .file-item {
            padding: 12px 16px;
            cursor: pointer;
            border-left: 3px solid transparent;
            transition: all 0.15s;
            min-height: 56px;
        }
        .file-item:active { background: #1f232c; }
        .file-item.active {
            background: #1e293b;
            border-left-color: #3b82f6;
        }
        .file-name {
            font-size: 14px; font-weight: 500;
            margin-bottom: 4px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .file-meta {
            font-size: 12px; color: #6b7280;
            display: flex; gap: 8px; align-items: center;
        }
        .file-type {
            padding: 2px 6px; border-radius: 4px;
            font-size: 10px; font-weight: 600; text-transform: uppercase;
        }
        .type-m3u8 { background: rgba(59,130,246,0.2); color: #60a5fa; }
        .type-mp4 { background: rgba(34,197,94,0.2); color: #4ade80; }
        .file-count { margin-left: auto; color: #6b7280; font-size: 12px; }
        .empty-state {
            padding: 60px 20px; text-align: center;
            color: #6b7280; font-size: 14px;
        }
        .empty-state-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.5; }
        
        /* 播放区 */
        .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .player-header {
            padding: 16px 24px;
            border-bottom: 1px solid #242831;
        }
        .player-title { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
        .player-desc {
            font-size: 12px; color: #6b7280;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .player-container {
            flex: 1; padding: 20px;
            display: flex; align-items: center; justify-content: center;
            background: #000; position: relative;
        }
        .player-wrap {
            width: 100%; max-width: 1200px;
            position: relative; border-radius: 8px;
            overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        }
        video {
            width: 100%; display: block;
            max-height: calc(100vh - 180px);
            background: #000;
        }
        .no-video { text-align: center; color: #4b5563; }
        .no-video-icon { font-size: 64px; margin-bottom: 16px; opacity: 0.3; }
        
        /* 控制栏 */
        .controls {
            position: absolute; bottom: 0; left: 0; right: 0;
            background: linear-gradient(transparent, rgba(0,0,0,0.8));
            padding: 30px 16px 12px;
            opacity: 0; transition: opacity 0.3s;
        }
        .player-wrap:hover .controls, .player-wrap:active .controls { opacity: 1; }
        .progress-bar {
            width: 100%; height: 6px;
            background: rgba(255,255,255,0.2);
            border-radius: 3px; cursor: pointer; margin-bottom: 12px;
        }
        .progress-filled {
            height: 100%; background: #3b82f6;
            border-radius: 3px; width: 0%; position: relative;
        }
        .control-row { display: flex; align-items: center; gap: 14px; }
        .ctrl-btn {
            background: none; border: none; color: #fff;
            font-size: 18px; cursor: pointer;
            width: 36px; height: 36px;
            display: flex; align-items: center; justify-content: center;
        }
        .time-display { font-size: 13px; color: rgba(255,255,255,0.8); }
        .spacer { flex: 1; }
        .speed-select {
            background: rgba(0,0,0,0.5); color: #fff;
            border: 1px solid rgba(255,255,255,0.2);
            padding: 4px 8px; border-radius: 6px;
            font-size: 12px; cursor: pointer; min-height: 32px;
        }
        
        /* 移动端底部导航 */
        .mobile-tabbar {
            display: none; position: fixed; bottom: 0; left: 0; right: 0;
            background: #171a21; border-top: 1px solid #242831;
            z-index: 100; padding-bottom: env(safe-area-inset-bottom);
        }
        .tab-list { display: flex; list-style: none; }
        .tab-item {
            flex: 1; text-align: center; padding: 10px 0;
            cursor: pointer; min-height: 56px;
            display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 2px;
        }
        .tab-item.active { color: #3b82f6; }
        .tab-icon { font-size: 20px; }
        .tab-text { font-size: 11px; }
        
        /* 滚动条 */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
        
        /* 响应式 */
        @media (max-width: 768px) {
            .app { flex-direction: column; padding-bottom: calc(60px + env(safe-area-inset-bottom)); }
            .sidebar {
                width: 100%; height: 100%;
                position: absolute; top: 0; left: 0;
                border-right: none;
                transform: translateX(-100%); transition: transform 0.3s ease;
                z-index: 10;
            }
            .sidebar.page-active { transform: translateX(0); }
            .main {
                width: 100%; height: 100%;
                position: absolute; top: 0; left: 0;
                transform: translateX(100%); transition: transform 0.3s ease;
                z-index: 10;
            }
            .main.page-active { transform: translateX(0); }
            .mobile-tabbar { display: block; }
            .player-container { padding: 0; }
            .player-wrap { border-radius: 0; box-shadow: none; max-width: 100%; }
            video { max-height: none; height: auto; }
            .player-header { padding: 12px 16px; }
            .player-title { font-size: 16px; }
            .controls { padding: 40px 16px 16px; }
            .progress-bar { height: 8px; margin-bottom: 16px; }
            .ctrl-btn { width: 44px; height: 44px; font-size: 20px; }
        }
        
        @media (max-width: 768px) and (orientation: landscape) {
            .player-container { padding: 0; }
            video { height: 100vh; height: 100dvh; object-fit: contain; }
            .player-header { display: none; }
            .mobile-tabbar { display: none; }
            .app { padding-bottom: 0; }
        }
    </style>
</head>
<body>
    <div class="app">
        <div class="sidebar page-active" id="sidebar">
            <div class="sidebar-header">
                <div class="sidebar-title">
                    📁 视频库
                    <span class="file-count" id="fileCount">0</span>
                </div>
                <div class="search-box">
                    <input type="text" id="searchInput" placeholder="搜索视频...">
                </div>
            </div>
            <div class="file-list" id="fileList">
                <div class="empty-state">
                    <div class="empty-state-icon">⏳</div>
                    <p>加载中...</p>
                </div>
            </div>
        </div>

        <div class="main" id="main">
            <div class="player-header">
                <div class="player-title" id="playerTitle">未选择视频</div>
                <div class="player-desc" id="playerDesc">从左侧列表选择一个视频开始播放</div>
            </div>
            <div class="player-container">
                <div class="no-video" id="noVideo">
                    <div class="no-video-icon">🎬</div>
                    <p>选择左侧的视频开始播放</p>
                </div>
                <div class="player-wrap" id="playerWrap" style="display:none;">
                    <video id="videoPlayer" playsinline webkit-playsinline></video>
                    <div class="controls">
                        <div class="progress-bar" id="progressBar">
                            <div class="progress-filled" id="progressFilled"></div>
                        </div>
                        <div class="control-row">
                            <button class="ctrl-btn" id="playBtn" onclick="togglePlay()">▶</button>
                            <span class="time-display">
                                <span id="currentTime">00:00</span> / <span id="duration">00:00</span>
                            </span>
                            <div class="spacer"></div>
                            <select class="speed-select" id="speedSelect" onchange="changeSpeed()">
                                <option value="0.5">0.5x</option>
                                <option value="0.75">0.75x</option>
                                <option value="1" selected>1x</option>
                                <option value="1.25">1.25x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2x</option>
                            </select>
                            <button class="ctrl-btn" onclick="toggleFullscreen()">⛶</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="mobile-tabbar">
        <div class="tab-list">
            <div class="tab-item active" data-tab="list" onclick="switchTab('list')">
                <div class="tab-icon">📁</div>
                <div class="tab-text">视频库</div>
            </div>
            <div class="tab-item" data-tab="player" onclick="switchTab('player')">
                <div class="tab-icon">🎬</div>
                <div class="tab-text">播放器</div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
    <script>
        let videos = [];
        let currentId = null;
        let hls = null;
        let isMobile = window.innerWidth <= 768;

        // 初始化
        async function init() {
            await loadVideos();
            renderList();
            bindEvents();
            window.addEventListener('resize', () => {
                isMobile = window.innerWidth <= 768;
            });
        }

        // 加载视频列表
        async function loadVideos() {
            try {
                const res = await fetch('/api/videos');
                videos = await res.json();
            } catch (e) {
                console.error('加载失败', e);
                document.getElementById('fileList').innerHTML = 
                    '<div class="empty-state"><div class="empty-state-icon">❌</div><p>加载失败</p></div>';
            }
        }

        // 切换Tab
        function switchTab(tab) {
            const sidebar = document.getElementById('sidebar');
            const main = document.getElementById('main');
            document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
            document.querySelector(\`[data-tab="\${tab}"]\`).classList.add('active');
            
            if (tab === 'list') {
                sidebar.classList.add('page-active');
                main.classList.remove('page-active');
            } else {
                sidebar.classList.remove('page-active');
                main.classList.add('page-active');
            }
        }

        // 渲染列表
        function renderList(filter = '') {
            const listEl = document.getElementById('fileList');
            const countEl = document.getElementById('fileCount');
            
            const filtered = videos.filter(v => 
                v.name.toLowerCase().includes(filter.toLowerCase()) ||
                v.url.toLowerCase().includes(filter.toLowerCase())
            );

            countEl.textContent = filtered.length;

            if (filtered.length === 0) {
                listEl.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">🔍</div>
                        <p>没有找到视频</p>
                    </div>
                \`;
                return;
            }

            listEl.innerHTML = filtered.map(v => \`
                <div class="file-item \${v.id === currentId ? 'active' : ''}" onclick="playVideo(\${v.id})">
                    <div class="file-name">\${escapeHtml(v.name)}</div>
                    <div class="file-meta">
                        <span class="file-type type-\${v.type}">\${v.type}</span>
                        <span>\${v.remark ? escapeHtml(v.remark.substring(0,15)) : '无备注'}</span>
                    </div>
                </div>
            \`).join('');
        }

        // 播放视频
        function playVideo(id) {
            const video = videos.find(v => v.id === id);
            if (!video) return;

            currentId = id;
            renderList(document.getElementById('searchInput').value);

            if (isMobile) switchTab('player');

            document.getElementById('playerTitle').textContent = video.name;
            document.getElementById('playerDesc').textContent = video.remark || video.url;
            document.getElementById('noVideo').style.display = 'none';
            document.getElementById('playerWrap').style.display = 'block';

            // 使用代理解决跨域
            const proxyUrl = '/proxy?url=' + encodeURIComponent(video.url);
            loadSource(proxyUrl, video.type);
        }

        function loadSource(url, type) {
            const videoEl = document.getElementById('videoPlayer');
            if (hls) { hls.destroy(); hls = null; }

            if (type === 'm3u8') {
                if (Hls.isSupported()) {
                    hls = new Hls({ enableWorker: true });
                    hls.loadSource(url);
                    hls.attachMedia(videoEl);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        videoEl.play().catch(() => {});
                    });
                } else {
                    videoEl.src = url;
                    videoEl.play().catch(() => {});
                }
            } else {
                videoEl.src = url;
                videoEl.play().catch(() => {});
            }
        }

        // 播放控制
        function togglePlay() {
            const v = document.getElementById('videoPlayer');
            v.paused ? v.play() : v.pause();
        }

        const videoEl = document.getElementById('videoPlayer');
        const playBtn = document.getElementById('playBtn');
        const progressBar = document.getElementById('progressBar');
        const progressFilled = document.getElementById('progressFilled');
        const currentTimeEl = document.getElementById('currentTime');
        const durationEl = document.getElementById('duration');

        videoEl.addEventListener('play', () => playBtn.textContent = '⏸');
        videoEl.addEventListener('pause', () => playBtn.textContent = '▶');
        videoEl.addEventListener('click', togglePlay);
        videoEl.addEventListener('timeupdate', () => {
            const percent = (videoEl.currentTime / videoEl.duration) * 100;
            progressFilled.style.width = percent + '%';
            currentTimeEl.textContent = formatTime(videoEl.currentTime);
        });
        videoEl.addEventListener('loadedmetadata', () => {
            durationEl.textContent = formatTime(videoEl.duration);
        });

        progressBar.addEventListener('click', (e) => {
            const rect = progressBar.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            videoEl.currentTime = percent * videoEl.duration;
        });

        // 触摸支持
        progressBar.addEventListener('touchstart', (e) => {
            const rect = progressBar.getBoundingClientRect();
            const percent = (e.touches[0].clientX - rect.left) / rect.width;
            videoEl.currentTime = percent * videoEl.duration;
        });

        function changeSpeed() {
            videoEl.playbackRate = parseFloat(document.getElementById('speedSelect').value);
        }

        function toggleFullscreen() {
            const wrap = document.getElementById('playerWrap');
            if (!document.fullscreenElement) {
                wrap.requestFullscreen?.() || wrap.webkitRequestFullscreen?.();
            } else {
                document.exitFullscreen?.() || document.webkitExitFullscreen?.();
            }
        }

        function formatTime(seconds) {
            if (isNaN(seconds)) return '00:00';
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return \`\${m.toString().padStart(2,'0')}:\${s.toString().padStart(2,'0')}\`;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function bindEvents() {
            document.getElementById('searchInput').addEventListener('input', (e) => {
                renderList(e.target.value);
            });
        }

        init();
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ==========================================
//  管理后台 HTML
// ==========================================
function renderAdminPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>视频管理后台</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0f1115;
            color: #e6e6e6;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
        }
        .header {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 20px;
        }
        .header h1 { font-size: 22px; font-weight: 600; }
        .btn {
            padding: 8px 16px; border: none; border-radius: 8px;
            font-size: 14px; cursor: pointer; transition: all 0.2s;
            display: inline-flex; align-items: center; gap: 6px;
        }
        .btn-primary { background: #3b82f6; color: #fff; }
        .btn-primary:hover { background: #2563eb; }
        .btn-secondary { background: #2a2f3a; color: #e6e6e6; }
        .btn-secondary:hover { background: #374151; }
        .btn-danger { background: #ef4444; color: #fff; }
        .btn-danger:hover { background: #dc2626; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        
        .toolbar {
            background: #171a21;
            border: 1px solid #242831;
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            display: flex; gap: 10px; flex-wrap: wrap;
        }
        .toolbar input {
            flex: 1; min-width: 200px;
            padding: 10px 14px;
            background: #1f232c;
            border: 1px solid #2a2f3a;
            border-radius: 8px;
            color: #fff; font-size: 14px; outline: none;
        }
        
        .video-table {
            background: #171a21;
            border: 1px solid #242831;
            border-radius: 12px;
            overflow: hidden;
        }
        .table-header {
            display: grid;
            grid-template-columns: 1fr 80px 120px;
            padding: 12px 16px;
            background: #1f232c;
            font-size: 13px; font-weight: 600; color: #9ca3af;
        }
        .video-row {
            display: grid;
            grid-template-columns: 1fr 80px 120px;
            padding: 14px 16px;
            border-top: 1px solid #242831;
            align-items: center;
            gap: 12px;
        }
        .video-info .name {
            font-size: 14px; font-weight: 500; margin-bottom: 4px;
        }
        .video-info .url {
            font-size: 12px; color: #6b7280;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .video-type {
            text-align: center;
        }
        .type-tag {
            padding: 2px 8px; border-radius: 4px;
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            display: inline-block;
        }
        .type-m3u8 { background: rgba(59,130,246,0.2); color: #60a5fa; }
        .type-mp4 { background: rgba(34,197,94,0.2); color: #4ade80; }
        .video-actions {
            display: flex; gap: 6px; justify-content: flex-end;
        }
        
        .empty {
            padding: 60px 20px; text-align: center; color: #6b7280;
        }
        .empty-icon { font-size: 40px; margin-bottom: 12px; }
        
        /* 模态框 */
        .modal-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7);
            display: none; align-items: center; justify-content: center;
            z-index: 1000; padding: 20px;
        }
        .modal-overlay.show { display: flex; }
        .modal {
            background: #1f232c;
            border-radius: 12px;
            width: 480px; max-width: 100%;
            border: 1px solid #2a2f3a;
            overflow: hidden;
        }
        .modal-header {
            padding: 16px 20px;
            border-bottom: 1px solid #2a2f3a;
            font-size: 16px; font-weight: 600;
        }
        .modal-body { padding: 20px; }
        .form-group { margin-bottom: 16px; }
        .form-group label {
            display: block; margin-bottom: 6px;
            font-size: 13px; color: #9ca3af;
        }
        .form-group input, .form-group textarea {
            width: 100%; padding: 10px 14px;
            background: #171a21;
            border: 1px solid #2a2f3a;
            border-radius: 8px;
            color: #fff; font-size: 14px; outline: none;
            font-family: inherit;
        }
        .form-group textarea { min-height: 80px; resize: vertical; }
        .modal-footer {
            padding: 12px 20px;
            border-top: 1px solid #2a2f3a;
            display: flex; justify-content: flex-end; gap: 10px;
        }
        
        @media (max-width: 600px) {
            body { padding: 12px; }
            .table-header { display: none; }
            .video-row {
                grid-template-columns: 1fr;
                gap: 8px;
            }
            .video-actions { justify-content: flex-start; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎛️ 视频管理后台</h1>
            <a href="/" class="btn btn-secondary">← 返回播放页</a>
        </div>

        <div class="toolbar">
            <input type="text" id="searchInput" placeholder="搜索视频名称或链接...">
            <button class="btn btn-primary" onclick="openAddModal()">➕ 添加视频</button>
        </div>

        <div class="video-table">
            <div class="table-header">
                <div>视频信息</div>
                <div>类型</div>
                <div>操作</div>
            </div>
            <div id="videoList">
                <div class="empty">
                    <div class="empty-icon">⏳</div>
                    <p>加载中...</p>
                </div>
            </div>
        </div>
    </div>

    <!-- 编辑模态框 -->
    <div class="modal-overlay" id="modal">
        <div class="modal">
            <div class="modal-header" id="modalTitle">添加视频</div>
            <div class="modal-body">
                <div class="form-group">
                    <label>视频名称 *</label>
                    <input type="text" id="inputName" placeholder="输入视频名称">
                </div>
                <div class="form-group">
                    <label>视频链接 *</label>
                    <input type="text" id="inputUrl" placeholder="粘贴 m3u8 或 MP4 链接">
                </div>
                <div class="form-group">
                    <label>备注（可选）</label>
                    <textarea id="inputRemark" placeholder="添加备注信息"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" onclick="saveVideo()">保存</button>
            </div>
        </div>
    </div>

    <script>
        let videos = [];
        let editingId = null;

        async function init() {
            await loadVideos();
            renderList();
            document.getElementById('searchInput').addEventListener('input', (e) => {
                renderList(e.target.value);
            });
        }

        async function loadVideos() {
            const res = await fetch('/api/videos');
            videos = await res.json();
        }

        function renderList(filter = '') {
            const listEl = document.getElementById('videoList');
            const filtered = videos.filter(v => 
                v.name.toLowerCase().includes(filter.toLowerCase()) ||
                v.url.toLowerCase().includes(filter.toLowerCase())
            );

            if (filtered.length === 0) {
                listEl.innerHTML = \`
                    <div class="empty">
                        <div class="empty-icon">📭</div>
                        <p>暂无视频</p>
                    </div>
                \`;
                return;
            }

            listEl.innerHTML = filtered.map(v => \`
                <div class="video-row">
                    <div class="video-info">
                        <div class="name">\${escapeHtml(v.name)}</div>
                        <div class="url">\${escapeHtml(v.url)}</div>
                    </div>
                    <div class="video-type">
                        <span class="type-tag type-\${v.type}">\${v.type}</span>
                    </div>
                    <div class="video-actions">
                        <button class="btn btn-secondary btn-sm" onclick="editVideo(\${v.id})">编辑</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteVideo(\${v.id})">删除</button>
                    </div>
                </div>
            \`).join('');
        }

        function openAddModal() {
            editingId = null;
            document.getElementById('modalTitle').textContent = '添加视频';
            document.getElementById('inputName').value = '';
            document.getElementById('inputUrl').value = '';
            document.getElementById('inputRemark').value = '';
            document.getElementById('modal').classList.add('show');
            document.getElementById('inputName').focus();
        }

        function editVideo(id) {
            const v = videos.find(x => x.id === id);
            if (!v) return;
            editingId = id;
            document.getElementById('modalTitle').textContent = '编辑视频';
            document.getElementById('inputName').value = v.name;
            document.getElementById('inputUrl').value = v.url;
            document.getElementById('inputRemark').value = v.remark || '';
            document.getElementById('modal').classList.add('show');
        }

        function closeModal() {
            document.getElementById('modal').classList.remove('show');
            editingId = null;
        }

        async function saveVideo() {
            const name = document.getElementById('inputName').value.trim();
            const url = document.getElementById('inputUrl').value.trim();
            const remark = document.getElementById('inputRemark').value.trim();

            if (!name || !url) {
                alert('请填写名称和链接');
                return;
            }

            const data = { name, url, remark };

            if (editingId) {
                await fetch(\`/api/videos/\${editingId}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
            } else {
                await fetch('/api/videos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
            }

            await loadVideos();
            renderList(document.getElementById('searchInput').value);
            closeModal();
        }

        async function deleteVideo(id) {
            if (!confirm('确定删除这个视频？')) return;
            await fetch(\`/api/videos/\${id}\`, { method: 'DELETE' });
            await loadVideos();
            renderList(document.getElementById('searchInput').value);
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // 点击外部关闭
        document.getElementById('modal').addEventListener('click', (e) => {
            if (e.target.id === 'modal') closeModal();
        });

        init();
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
