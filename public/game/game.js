const cloudSavesStatus = document.getElementById('cloud-saves-status');
var statusElement = document.getElementById("status");
var progressElement = document.getElementById("progress");
var spinnerElement = document.getElementById('spinner');
var data_content;
var wasm_content;

const params = new URLSearchParams(window.location.search);

// Base URLs
const replaceFetch = (str) => str.replace("https://cdn.dos.zone/vcsky/", "/vcsky/")
const replaceBR = "/vcbr/"

// Configurable mode - show settings UI before play
const configurableMode = params.get('configurable') === "1";

// Settings that can be configured via URL or UI
let autoFullScreen = params.get('fullscreen') !== "0";
let cheatsEnabled = params.get('cheats') === "1" || configurableMode;
let maxFPS = parseInt(params.get('max_fps')) || 0;

// full game access
if (params.get('request_original_game') !== "1")
    localStorage.setItem('vcsky.haveOriginalGame', 'true');

const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS desktop-mode UA
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
let isTouch = coarsePointer || (isMobile && navigator.maxTouchPoints > 0);

document.body.dataset.isTouch = isTouch ? 1 : 0;

const dataSize = 130 * 1024 * 1024;
const textDecoder = new TextDecoder();
let haveOriginalGame = false;
const translations = {
    en: {
        clickToPlayDemo: "Click to play demo",
        clickToPlayFull: "Click to play",
        invalidKey: "invalid key",
        checking: "checking...",
        cloudSaves: "Cloud saves:",
        enabled: "enabled",
        disabled: "disabled",
        playDemoText: "You can play the DEMO version, or provide the original game files to play the full version.",
        disclaimer: "DISCLAIMER:",
        disclaimerSources: "This game is based on an open source version of GTA: Vice City. It is not a commercial release and is not affiliated with Rockstar Games.",
        disclaimerCheckbox: "I own the original game",
        disclaimerPrompt: "You need to provide a file from the original game to confirm ownership of the original game.",
        cantContinuePlaying: "You can't continue playing in DEMO version. Please provide the original game files to continue playing.",
        demoAlert: "The demo version is intended only for familiarizing yourself with the game technology. All features are available, but you won't be able to progress through the game's storyline. Please provide the original game files to launch the full version.",
        downloading: "Downloading",
        decompressing: "Decompressing...",
        downloadFailed: "Download failed. Please check your connection and reload the page to retry.",
        serverPreparing: "Server is preparing game assets (%1%), first launch can take a few minutes...",
        enterKey: "enter your key",
        clickToContinue: "Click to continue...",
        enterJsDosKey: "Enter js-dos key (5 len)",
        portBy: "HTML5 port by:",
        ruTranslate: "",
        demoOffDisclaimer: "Due to the unexpectedly high popularity of the project, resulting in significant traffic costs, and in order to avoid any risk of the project being shut down due to rights holder claims, we have disabled the demo version. You can still run the full version by providing the original game resources.",
        configLanguage: "Language:",
        configCheats: "Cheats (F3)",
        configFullscreen: "Fullscreen",
        configMaxFps: "Max FPS:",
        configUnlimited: "(0 = unlimited)",
    },
    ru: {
        clickToPlayDemo: "Играть в демо версию",
        clickToPlayFull: "Играть",
        invalidKey: "неверный ключ",
        checking: "проверка...",
        cloudSaves: "Облачные сохранения:",
        enabled: "включены",
        disabled: "выключены",
        playDemoText: "Вы можете играть в демо версию, или предоставить оригинальные файлы игры для полной версии.",
        disclaimer: "ОТКАЗ ОТ ОТВЕТСТВЕННОСТИ:",
        disclaimerSources: "Эта игра основана на открытой версии GTA: Vice City. Она не является коммерческим изданием и не связана с Rockstar Games.",
        disclaimerCheckbox: "Я владею оригинальной игрой",
        disclaimerPrompt: "Вам потребуется приложить какой-либо файл из оригинальной игры для подтверждения владения оригинальной игрой.",
        cantContinuePlaying: "Вы не можете продолжить игру в демо версии. Пожалуйста, предоставьте оригинальные файлы игры для продолжения игры.",
        demoAlert: "Демо версия предназначена только для ознакомления с технологией игры. Все функции доступны, но вы не сможете продолжить игру по сюжету. Пожалуйста, предоставьте оригинальные файлы игры для запуска полной версии.",
        downloading: "Загрузка",
        decompressing: "Распаковка...",
        downloadFailed: "Ошибка загрузки. Проверьте соединение и обновите страницу.",
        serverPreparing: "Сервер готовит игровые ресурсы (%1%), первый запуск может занять несколько минут...",
        enterKey: "введите ваш ключ",
        clickToContinue: "Нажмите для продолжения...",
        enterJsDosKey: "Введите ключ js-dos (5 букв)",
        portBy: "Авторы HTML5 порта:",
        ruTranslate: `
<div class="translated-by">
    <span>Переведено на русский студией</span>
    <a href="https://www.gamesvoice.ru/" target="_blank">GamesVoice</a>
</div>
`,
        demoOffDisclaimer: "В связи с неожиданно высокой популярностью проекта, как следствие — значительными расходами на трафик, а также во избежание рисков закрытия проекта из-за претензий правообладателей, мы отключили возможность запуска демо-версии. При этом вы по-прежнему можете запустить полную версию, предоставив оригинальные ресурсы.",
        configLanguage: "Язык:",
        configCheats: "Читы (F3)",
        configFullscreen: "Полный экран",
        configMaxFps: "Макс. FPS:",
        configUnlimited: "(0 = без ограничений)",
    },
    // Simplified Chinese localization of the LAUNCHER UI only.
    // Upstream ships no Chinese game asset pack (vc-sky-en / vc-sky-ru only,
    // and GTA:VC has no official Chinese release), so the game itself always
    // runs with the English data pack.
    zh: {
        clickToPlayDemo: "点击开始游戏",
        clickToPlayFull: "点击开始游戏",
        invalidKey: "无效密钥",
        checking: "检查中...",
        cloudSaves: "云端存档：",
        enabled: "已启用",
        disabled: "未启用",
        playDemoText: "你可以游玩试玩版，或提供原版游戏文件解锁完整版。",
        disclaimer: "免责声明：",
        disclaimerSources: "本游戏基于 GTA: 罪恶都市的开源版本构建，并非商业发行版，与 Rockstar Games 无关。",
        disclaimerCheckbox: "我拥有原版游戏",
        disclaimerPrompt: "需要提供原版游戏中的任意文件以验证你拥有原版游戏。",
        cantContinuePlaying: "试玩版无法继续游戏，请提供原版游戏文件以继续。",
        demoAlert: "试玩版仅供了解游戏技术。虽然功能完整，但无法推进剧情。请提供原版游戏文件以启动完整版。",
        downloading: "下载中",
        decompressing: "解压中...",
        downloadFailed: "下载失败，请检查网络后刷新页面重试。",
        serverPreparing: "服务器正在准备游戏资源（%1%），首次启动可能需要几分钟，请稍候…",
        enterKey: "输入你的密钥",
        clickToContinue: "点击继续...",
        enterJsDosKey: "输入 js-dos 密钥（5 位）",
        portBy: "HTML5 移植：",
        ruTranslate: "",
        demoOffDisclaimer: "由于项目流量成本过高，为避免版权风险，试玩版已停用。你仍可通过提供原版游戏资源运行完整版。",
        configLanguage: "界面语言：",
        configCheats: "作弊菜单 (F3)",
        configFullscreen: "全屏",
        configMaxFps: "最高帧率：",
        configUnlimited: "（0 = 不限制）",
    },
};

// Launcher UI language: Simplified Chinese by default for Chinese browsers,
// English otherwise. The Russian UI and the ru game asset pack are disabled
// on purpose; "lang" accepts only "en" / "zh" now.
var currentLanguage = (navigator.language || "en").split("-")[0].toLowerCase() === "zh" ? "zh" : "en";
if (params.get("lang") === "en") {
    currentLanguage = "en";
} else if (params.get("lang") === "zh") {
    currentLanguage = "zh";
}

window.t = function (key) {
    return translations[currentLanguage][key];
}

// Function to update all translated texts on the page
function updateAllTranslations() {
    const keyInput = document.querySelector('.jsdos-key-input');
    if (keyInput) keyInput.setAttribute('placeholder', t("enterJsDosKey"));
    
    const clickToPlayButton = document.getElementById('click-to-play-button');
    if (clickToPlayButton) {
        clickToPlayButton.textContent = haveOriginalGame ? t('clickToPlayFull') : t('clickToPlayDemo');
    }
    
    const demoOffDisclaimer = document.getElementById('demo-off-disclaimer');
    if (demoOffDisclaimer) {
        demoOffDisclaimer.textContent = haveOriginalGame ? "" : "* " + t('demoOffDisclaimer');
    }
    
    const cloudSavesLink = document.getElementById('cloud-saves-link');
    if (cloudSavesLink) cloudSavesLink.textContent = t('cloudSaves');
    
    const cloudSavesStatus = document.getElementById('cloud-saves-status');
    if (cloudSavesStatus) cloudSavesStatus.textContent = t('enterKey');
    
    const playDemoText = document.getElementById('play-demo-text');
    if (playDemoText) playDemoText.textContent = t('playDemoText');
    
    const disclaimerText = document.getElementById('disclaimer-text');
    if (disclaimerText) disclaimerText.textContent = t('disclaimer');
    
    const disclaimerSources = document.getElementById('disclaimer-sources');
    if (disclaimerSources) disclaimerSources.textContent = t('disclaimerSources');
    
    const disclaimerCheckboxLabel = document.getElementById('disclaimer-checkbox-label');
    if (disclaimerCheckboxLabel) disclaimerCheckboxLabel.textContent = t('disclaimerCheckbox');
    
    const portBy = document.getElementById('port-by');
    if (portBy) portBy.textContent = t('portBy');
    
    // Update developed-by section for ruTranslate
    const developedBy = document.querySelector('.developed-by');
    const existingTranslatedBy = developedBy?.querySelector('.translated-by');
    if (existingTranslatedBy) existingTranslatedBy.remove();
    if (developedBy && t('ruTranslate')) {
        developedBy.insertAdjacentHTML('beforeend', t('ruTranslate'));
    }
    
    // Update config panel labels if present
    const configLangLabel = document.getElementById('config-lang-label');
    if (configLangLabel) configLangLabel.textContent = t('configLanguage');
    
    const configCheatsLabel = document.getElementById('config-cheats-label');
    if (configCheatsLabel) configCheatsLabel.textContent = t('configCheats');
    
    const configFullscreenLabel = document.getElementById('config-fullscreen-label');
    if (configFullscreenLabel) configFullscreenLabel.textContent = t('configFullscreen');
    
    const configMaxFpsLabel = document.getElementById('config-max-fps-label');
    if (configMaxFpsLabel) configMaxFpsLabel.textContent = t('configMaxFps');
    
    const configMaxFpsUnlimited = document.getElementById('config-max-fps-unlimited');
    if (configMaxFpsUnlimited) configMaxFpsUnlimited.textContent = t('configUnlimited');
}

// Game data files. There is no Chinese asset pack upstream (vc-sky-en / vc-sky-ru
// only), so the English data pack is always used regardless of UI language.
function updateGameDataForLanguage(lang) {
    data_content = `${replaceBR}vc-sky-en-v6.data.br`;
    wasm_content = `${replaceBR}vc-sky-en-v6.wasm.br`;
}

// Initialize data files based on current language
updateGameDataForLanguage(currentLanguage);

// ---- Robust large-file download ------------------------------------------
// The data package is ~135 MB. A single huge streamed response can be
// truncated or stalled by intermediary proxies (in the published deployment
// the download froze at 39% and the page never recovered). We therefore
// fetch the file in small HTTP Range chunks — the server serves slices of
// the final content, so every request is small enough for any proxy/edge to
// handle — and retry each chunk on failure. Falls back to the original
// single-stream fetch when Range is not honoured.
const DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 45000;
const CHUNK_RETRIES = 5;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms) {
    try {
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            return AbortSignal.timeout(ms);
        }
    } catch (e) { /* not supported */ }
    return undefined;
}

async function fetchWithRetry(url, headers, retries, timeoutMs, label) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const signal = timeoutSignal(timeoutMs);
            // cache: 'no-store' bypasses the HTTP disk cache — a previously
            // cached full-file response (Content-Encoding: br) makes Chromium
            // serve mangled bodies for ranged requests to the same URL.
            return await fetch(url, { headers, signal, cache: 'no-store' });
        } catch (err) {
            lastErr = err;
            console.warn(`[download] ${label} attempt ${attempt}/${retries} failed:`, err && err.message ? err.message : err);
            await sleep(Math.min(500 * attempt, 3000));
        }
    }
    throw lastErr;
}

// Decompress brotli bytes in the browser. Returns null when unsupported/failed.
async function brotliDecompress(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('br'));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
    } catch (e) {
        console.warn('[download] browser brotli decompress failed:', e && e.message ? e.message : e);
        return null;
    }
}

// Probe the total size of the file via a 1-byte Range request. Returns 0
// when Range is not honoured (caller falls back).
async function probeStoredSize(url) {
    try {
        const res = await fetchWithRetry(url, { Range: 'bytes=0-0' }, 3, 20000, 'probe');
        if (res.status === 206) {
            const cr = res.headers.get('content-range') || '';
            const total = Number(cr.split('/')[1]);
            await res.arrayBuffer().catch(() => {});
            if (total > 0) return total;
        } else {
            await res.arrayBuffer().catch(() => {});
        }
    } catch (e) { /* fall through */ }
    return 0;
}

// Download the file content in ranged chunks and assemble it. Returns the
// assembled Uint8Array, or null when the server/proxy does not honour Range
// (the caller then falls back to the single-stream path).
async function downloadChunked(url, total, onProgress) {
    const out = new Uint8Array(total);
    let received = 0;
    while (received < total) {
        const start = received;
        const end = Math.min(start + DOWNLOAD_CHUNK_SIZE, total) - 1;
        let res;
        try {
            res = await fetchWithRetry(url, { Range: `bytes=${start}-${end}` }, CHUNK_RETRIES, CHUNK_TIMEOUT_MS, `chunk ${start}-${end}`);
        } catch (err) {
            return null;
        }
        if (res.status !== 206) {
            // A proxy ignored the Range header — the body would be the whole
            // file, unusable for chunk assembly.
            console.warn('[download] ranged request returned status', res.status, '— falling back');
            await res.arrayBuffer().catch(() => {});
            return null;
        }
        const chunk = new Uint8Array(await res.arrayBuffer());
        if (chunk.length === 0 || received + chunk.length > total) {
            console.warn('[download] unexpected chunk length', chunk.length);
            return null;
        }
        out.set(chunk, received);
        received += chunk.length;
        if (onProgress) onProgress(received, total);
    }
    return out;
}

// Original single-stream download (the response is transparently decoded by
// the browser when served with Content-Encoding: br).
async function downloadStreamed(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const reader = response.body.getReader();
    let receivedLength = 0;
    let chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        if (onProgress) onProgress(receivedLength);
    }
    const buffer = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, position);
        position += chunk.length;
    }
    return buffer;
}

async function loadData() {
    let cache;
    try {
        cache = await caches.open(location.hostname);
        const cached = await cache.match(data_content);
        if (cached && data_content !== "index.data") {
            return new Uint8Array(await cached.arrayBuffer());
        }
    } catch (e) {
        console.error('Failed to open cache:', e);
    }

    // On a freshly booted (published) container the server-side 1.08 GB
    // archive may still be downloading/indexing. Wait for it to become ready
    // instead of failing the game data download, and surface the preparation
    // progress on the game status line so the player knows what is going on.
    try {
        let idleTicks = 0;
        for (;;) {
            const res = await fetch('/api/archive/status', { cache: 'no-store' });
            if (!res.ok) break;
            const st = await res.json();
            if (!st || st.state === 'ready' || st.state === 'error') break;
            if (st.state === 'idle') {
                idleTicks++;
                if (idleTicks === 1) {
                    // Ensure preparation is kicked off even if the status bar
                    // component has not fired its own prepare call yet.
                    fetch('/api/archive/prepare', { method: 'POST' }).catch(() => {});
                }
                if (idleTicks > 20) break; // ~30s without starting — give up gracefully
            } else {
                const pct = st.state === 'indexing' ? 100 : (st.progress || 0);
                setStatus(t("serverPreparing").replace('%1%', String(pct)));
            }
            await sleep(1500);
        }
    } catch (e) {
        // Status endpoint unreachable — proceed; the download paths below
        // will surface a proper error if the archive is truly unavailable.
        console.warn('[loadData] archive status poll failed:', e && e.message ? e.message : e);
    }

    // Preferred: chunked ranged download — resilient against proxies that
    // truncate or stall long responses, retryable per chunk.
    try {
        const total = await probeStoredSize(data_content);
        if (total > 0) {
            setStatus(`Downloading...(0/${total})`);
            const data = await downloadChunked(data_content, total, (received, tot) => {
                setStatus(`Downloading...(${received}/${tot})`);
            });
            if (data) {
                if (cache) {
                    try {
                        await cache.put(data_content, new Response(data.buffer, { headers: { 'Content-Type': 'application/octet-stream' } }));
                    } catch (e) {
                        console.error('Failed to cache data:', e.message);
                    }
                }
                return data;
            }
        }
    } catch (e) {
        console.warn('[loadData] chunked download failed, falling back to streamed fetch:', e && e.message ? e.message : e);
    }

    // Fallback: original single-stream fetch.
    const data = await downloadStreamed(data_content, (receivedLength) => {
        setStatus(`Downloading...(${receivedLength}/${dataSize})`);
    });
    if (cache) {
        try {
            await cache.put(data_content, new Response(data.buffer, { headers: { 'Content-Type': 'application/octet-stream' } }));
        } catch (e) {
            console.error('Failed to cache data:', e.message);
        }
    }
    return data;
};

async function startGame(e) {
    e.stopPropagation();

    document.querySelector('.start-container').style.display = 'none';
    document.querySelector('.disclaimer').style.display = 'none';
    document.querySelector('.developed-by').style.display = 'none';

    const intro = document.querySelector('.intro');
    const introContainer = document.querySelector('.intro-container');
    const loaderContainer = document.querySelector('.loader-container');
    document.querySelector('.click-to-play').style.display = 'none';
    loaderContainer.style.display = "flex";
    introContainer.hidden = false;
    intro.play();

    let dataBuffer;
    try {
        dataBuffer = await loadData();
    } catch (err) {
        console.error('[loadData] fatal:', err);
        spinnerElement.hidden = true;
        setStatus(t("downloadFailed"));
        progressElement.hidden = true;
        throw err;
    }
    spinnerElement.hidden = true;
    setStatus(t("clickToContinue"));
    introContainer.hidden = false;
    introContainer.style.cursor = 'pointer';
    const clickHandler = () => {
        intro.pause();
        introContainer.style.display = 'none';
        loadGame(dataBuffer);
    };
    if (isMobile) {
        window.addEventListener('pointerup', clickHandler, { once: true });
    } else {
        window.addEventListener('click', clickHandler, { once: true });
    }
}

function setStatus(text) {
    if (!text) {
        progressElement.hidden = true;
        spinnerElement.hidden = true;
        return;
    }
    const match = text.match(/(.+)\((\d+\.?\d*)\/(\d+)\)/);
    if (match) {
        const [current, total] = match.slice(2, 4).map(Number);
        const percent = (current / total * 100).toFixed(0);
        statusElement.textContent = t("downloading") + ` ${percent}%`;
        progressElement.value = current;
        progressElement.max = total;
        progressElement.hidden = false;
        spinnerElement.hidden = false;
        const progressBarFill = spinnerElement.querySelector('.progress-bar-fill');
        if (progressBarFill) {
            progressBarFill.style.width = percent + '%';
        }
    } else {
        statusElement.textContent = text;
    }
};

async function loadGame(data) {
    var Module = {
        mainCalled: () => {
            try {
                Module.FS.unlink("/vc-assets/local/revc.ini");
                Module.FS.createDataFile("/vc-assets/local/revc.ini", 0, revc_ini, revc_ini.length);
            } catch (e) {
                console.error('mainCalled error:', e);
            }
        },
        syncRevcIni: () => {
            try {
                const path = Module.FS.lookupPath("/vc-assets/local/revc.ini");
                if (path && path.node && path.node.contents) {
                    localStorage.setItem('vcsky.revc.ini', textDecoder.decode(path.node.contents));
                }
            } catch (e) {
                console.error('syncRevcIni error:', e);
            }
        },
        preRun: [],
        postRun: [],
        print: (...args) => console.log(args.join(' ')),
        printErr: (...args) => console.error(args.join(' ')),
        getPreloadedPackage: () => {
            return data.buffer;
        },
        canvas: function () {
            const canvas = document.getElementById('canvas');
            canvas.addEventListener('webglcontextlost', (e) => {
                statusElement.textContent = 'WebGL context lost. Please reload the page.';
                e.preventDefault();
            });
            return canvas;
        }(),
        setStatus,
        totalDependencies: 0,
        monitorRunDependencies: (num) => {
            Module.totalDependencies = Math.max(Module.totalDependencies, num);
            Module.setStatus(`Preparing... (${Module.totalDependencies - num}/${Module.totalDependencies})`);
        },
        hotelMission: () => {
            if (!haveOriginalGame) {
                showWasted();
                alert(t("cantContinuePlaying"));
                throw new Error(t("cantContinuePlaying"));
            }
        },
    };
    Module.log = Module.print;
    Module.instantiateWasm = async (
        info,
        receiveInstance,
    ) => {
        const wasmUrl = wasm_content ? wasm_content : "index.wasm";
        const isWasmMagic = (bytes) => bytes && bytes.length > 4 &&
            bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
        const loadWasmBytes = async () => {
            // Preferred: small ranged chunks so a proxy truncating long
            // responses cannot break the engine; each chunk is retryable.
            try {
                const total = await probeStoredSize(wasmUrl);
                if (total > 0) {
                    const bytes = await downloadChunked(wasmUrl, total, null);
                    if (isWasmMagic(bytes)) return bytes;
                    console.warn('[wasm] chunked payload failed magic check, falling back');
                }
            } catch (e) {
                console.warn('[wasm] chunked load failed, falling back:', e && e.message ? e.message : e);
            }
            // Fallback: plain fetch with retries. The browser decodes
            // Content-Encoding: br transparently; if a proxy stripped the
            // header but not the bytes, decompress as a last resort.
            let lastErr;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const res = await fetch(wasmUrl);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    let bytes = new Uint8Array(await res.arrayBuffer());
                    if (isWasmMagic(bytes)) return bytes;
                    if (typeof DecompressionStream !== 'undefined') {
                        const dec = await brotliDecompress(bytes);
                        if (isWasmMagic(dec)) return dec;
                    }
                    throw new Error('bad wasm payload');
                } catch (err) {
                    lastErr = err;
                    console.warn(`[wasm] attempt ${attempt}/3 failed:`, err && err.message ? err.message : err);
                    await sleep(500 * attempt);
                }
            }
            throw lastErr;
        };
        const wasmBytes = await loadWasmBytes();
        const module = await WebAssembly.instantiate(wasmBytes, info);
        return receiveInstance(module.instance, module);
    };
    window.onerror = (message) => {
        Module.setStatus(`Error: ${message}`);
        spinnerElement.hidden = true;
    };
    Module.arguments = window.location.search
        .slice(1)
        .split('&')
        .filter(Boolean)
        .map(decodeURIComponent);
    window.onbeforeunload = function (event) {
        event.preventDefault();
        return '';
    };

    window.Module = Module;
    const script = document.createElement('script');
    script.async = true;
    script.src = '/game/index.js';
    document.body.appendChild(script);

    document.body.classList.add('gameIsStarted');

    const emulator = new GamepadEmulator();
    const gamepad = emulator.AddEmulatedGamepad(null, true);
    const gamepadEmulatorConfig = {
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: 100,
        tapTarget: move,
        lockTargetWhilePressed: true,
        xAxisIndex: 0,
        yAxisIndex: 1,
        swapAxes: false,
        invertX: false,
        invertY: false,
    };
    emulator.AddDisplayJoystickEventListeners(0, [gamepadEmulatorConfig]);
    const gamepadEmulatorConfig1 = {
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: 100,
        tapTarget: look,
        lockTargetWhilePressed: true,
        xAxisIndex: 2,
        yAxisIndex: 3,
        swapAxes: false,
        invertX: false,
        invertY: false,
    };
    emulator.AddDisplayJoystickEventListeners(0, [gamepadEmulatorConfig1]);

    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 9,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.menu'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 3,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.car.getIn'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 0,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.run'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 1,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fist'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 5,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.drift'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 2,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.jump'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 4,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.mobile'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 11,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.job'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 4,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.radio'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 7,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.weapon'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 8,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.camera'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 10,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.horn'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 7,
        buttonIndexes: [1, 7],
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fireRight'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 6,
        buttonIndexes: [1, 6],
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fireLeft'),
    }]);
}

const clickToPlay = document.querySelector('.click-to-play');
const clickLink = clickToPlay.querySelector('button');
clickToPlay.addEventListener('click', (e) => {
    if (!haveOriginalGame) {
        //     alert(t('demoAlert'));
        alert(t('demoOffDisclaimer'));
        return;
    }
    if (e.target === clickToPlay || e.target === clickLink) {
        startGame(e);
        if (!isMobile && autoFullScreen) {
            if (window.top === window) {
                document.body.requestFullscreen(document.documentElement);
            } else {
                window.top.postMessage({
                    event: 'request-fullscreen',
                }, '*');
            }
            function lockMouseIfNeeded() {
                if (!document.pointerLockElement && typeof Module !== 'undefined' && Module.canvas) {
                    Module.canvas.requestPointerLock({
                        unadjustedMovement: true,
                    }).catch(() => {
                        console.warn('Failed to lock in unadjusted movement mode');
                        Module.canvas.requestPointerLock().catch(() => {
                            console.error('Failed to lock in default mode');
                        });
                    });
                }
            }
            document.addEventListener("mousedown", lockMouseIfNeeded, { capture: true });
            if (navigator.keyboard && navigator.keyboard.lock) {
                navigator.keyboard.lock(["Escape", "KeyW"]);
            }
        }
    } else if (window.top !== window) {
        window.top.postMessage({
            event: 'request-fullscreen',
        }, '*');
    }
});

const savesMountPoint = "/vc-assets/local/userfiles";
const savesFile = "vcsky.saves";
wrapIDBFS(console.log).addListener({
    onLoad: (_, mount) => {
        if (mount.mountpoint !== savesMountPoint) {
            return null;
        }
        const token = localStorage.getItem('vcsky.key');
        if (token && token.length === 5) {
            const promise = CloudSDK.pullFromStorage(token, savesFile);
            promise.then((payload) => {
                console.log('[IDBFS] onLoad', token, payload ? payload.length / 1024 : 0, 'kb');
            });
            return promise;
        }
        return null;
    },
    onSave: (getData, _, mount) => {
        if (mount.mountpoint !== savesMountPoint) {
            return;
        }
        const token = localStorage.getItem('vcsky.key');
        if (token && token.length === 5) {
            getData().then((payload) => {
                if (payload.length > 0) {
                    console.log('[IDBFS] onSave', token, payload.length / 1024, 'kb');
                    return CloudSDK.pushToStorage(token, savesFile, payload);
                }
            });
        }
    },
});


function updateToken(token) {
    cloudSavesStatus.textContent = t('checking');
    if (token.length === 5) {
        CloudSDK.resolveToken(token).then((profile) => {
            if (profile) {
                console.log('[CloudSdk] resolveToken', profile);
                localStorage.setItem('vcsky.key', profile.token);
                if (profile.premium) {
                    keyStatus.textContent = t('enabled');
                    keyStatus.style.color = 'green';
                    keyStatus.style.fontWeight = 'bold';
                } else {
                    keyStatus.textContent = t('disabled');
                    keyStatus.style.color = 'red';
                    keyStatus.style.fontWeight = 'bold';
                }
            } else {
                keyStatus.textContent = t('invalidKey');
                keyStatus.style.color = 'white';
                keyStatus.style.fontWeight = 'normal';
            }
        });
    } else {
        cloudSavesStatus.textContent = t('enterKey');
    }
}

const keyInput = document.querySelector('.jsdos-key-input');
keyInput.setAttribute('placeholder', t("enterJsDosKey"));
const keyStatus = document.querySelector('.jsdos-key-status');
keyInput.addEventListener('paste', (e) => {
    setTimeout(() => {
        updateToken(e.target.value);
    }, 100);
});

keyInput.addEventListener('keyup', (e) => {
    updateToken(e.target.value);
});

if (localStorage.getItem('vcsky.key')) {
    keyInput.value = localStorage.getItem('vcsky.key');
    updateToken(keyInput.value);
} else {
    keyStatus.textContent = t('invalidKey');
    keyStatus.style.color = 'shite';
    keyStatus.style.fontWeight = 'normal';
}

const clickToPlayButton = document.getElementById('click-to-play-button');
clickToPlayButton.textContent = t('clickToPlayDemo');
clickToPlayButton.classList.add('disabled');
const demoOffDisclaimer = document.getElementById('demo-off-disclaimer');
demoOffDisclaimer.textContent = "* " +t('demoOffDisclaimer');
const cloudSavesLink = document.getElementById('cloud-saves-link');
cloudSavesLink.textContent = t('cloudSaves');
cloudSavesStatus.textContent = t('enterKey');
const playDemoText = document.getElementById('play-demo-text');
playDemoText.textContent = t('playDemoText');
const disclaimerText = document.getElementById('disclaimer-text');
disclaimerText.textContent = t('disclaimer');
const disclaimerSources = document.getElementById('disclaimer-sources');
disclaimerSources.textContent = t('disclaimerSources');
const disclaimerCheckboxLabel = document.getElementById('disclaimer-checkbox-label');
disclaimerCheckboxLabel.textContent = t('disclaimerCheckbox');
const disclaimerCheckbox = document.getElementById('disclaimer-checkbox');
const originalGameFile = document.getElementById('original-game-file');
const developedBy = document.querySelector('.developed-by');
developedBy.innerHTML += t('ruTranslate');
const portBy = document.getElementById('port-by');
portBy.textContent = t('portBy');


function ownerShipConfirmed() {
    localStorage.setItem('vcsky.haveOriginalGame', 'true');
    disclaimerCheckbox.checked = true;
    clickToPlayButton.textContent = t('clickToPlayFull');
    demoOffDisclaimer.textContent = "";
    clickToPlayButton.classList.remove('disabled');
    haveOriginalGame = true;
};

function ownerShipNotConfirmed() {
    localStorage.removeItem('vcsky.haveOriginalGame');
    disclaimerCheckbox.checked = false;
    clickToPlayButton.textContent = t('clickToPlayDemo');
    demoOffDisclaimer.textContent = "* " +t('demoOffDisclaimer');
    haveOriginalGame = false;
    clickToPlayButton.classList.add('disabled');
};

disclaimerCheckbox.addEventListener('change', async (inputEvent) => {
    if (inputEvent.target.checked) {
        if (confirm(t('disclaimerPrompt'))) {
            originalGameFile.addEventListener('change', async (e) => {
                try {
                    const file = e.target.files[0];
                    if (file) {
                        const sha256sums = (await (await fetch(replaceFetch("https://cdn.dos.zone/vcsky/sha256sums.txt"))).text()).toLowerCase();
                        const arrayBuffer = await file.arrayBuffer();
                        if (window.crypto && window.crypto.subtle) {
                            const hashBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
                            const hashArray = Array.from(new Uint8Array(hashBuffer));
                            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                            if (sha256sums.indexOf(hashHex) !== -1) {
                                ownerShipConfirmed();
                            } else {
                                ownerShipNotConfirmed();
                            }
                        } else {
                            ownerShipNotConfirmed();
                        }
                    } else {
                        ownerShipNotConfirmed();
                    }
                } catch (error) {
                    console.error('Error:', error);
                    ownerShipNotConfirmed();
                }
            }, { once: true });
            originalGameFile.click();
            return;
        }
    }

    ownerShipNotConfirmed();
});

localStorage.getItem('vcsky.haveOriginalGame') === 'true' ? ownerShipConfirmed() : ownerShipNotConfirmed();

function showWasted() {
    const wastedContainer = document.querySelector('.wasted-container');
    wastedContainer.hidden = false;
}

const revc_iniDefault = `
[VideoMode]
Width=800
Height=600
Depth=32
Subsystem=0
Windowed=0
[Controller]
HeadBob1stPerson=0
HorizantalMouseSens=0.002500
InvertMouseVertically=1
DisableMouseSteering=1
Vibration=0
Method=${isTouch ? '1' : '0'}
InvertPad=0
JoystickName=
PadButtonsInited=0
[Audio]
SfxVolume=36
MusicVolume=37
MP3BoostVolume=0
Radio=0
SpeakerType=0
Provider=0
DynamicAcoustics=1
[Display]
Brightness=256
DrawDistance=1.800000
Subtitles=0
ShowHud=1
RadarMode=0
ShowLegends=0
PedDensity=1.200000
CarDensity=1.200000
CutsceneBorders=1
FreeCam=0
[Graphics]
AspectRatio=0
VSync=1
Trails=1
FrameLimiter=0
MultiSampling=0
IslandLoading=0
PS2AlphaTest=1
ColourFilter=2
MotionBlur=0
VehiclePipeline=0
NeoRimLight=0
NeoLightMaps=0
NeoRoadGloss=0
[General]
SkinFile=$$""
Language=0
DrawVersionText=0
NoMovies=0
[CustomPipesValues]
PostFXIntensity=1.000000
NeoVehicleShininess=1.000000
NeoVehicleSpecularity=1.000000
RimlightMult=1.000000
LightmapMult=1.000000
GlossMult=1.000000
[Rendering]
BackfaceCulling=1
NewRenderer=1
[Draw]
ProperScaling=1
FixRadar=1
FixSprites=1
[Bindings]
PED_FIREWEAPON=mouse:LEFT,2ndKbd:PAD5
PED_CYCLE_WEAPON_RIGHT=2ndKbd:PADENTER,mouse:WHLDOWN,kbd:E
PED_CYCLE_WEAPON_LEFT=kbd:PADDEL,mouse:WHLUP,2ndKbd:Q
GO_FORWARD=kbd:UP,2ndKbd:W
GO_BACK=kbd:DOWN,2ndKbd:S
GO_LEFT=2ndKbd:A,kbd:LEFT
GO_RIGHT=kbd:RIGHT,2ndKbd:D
PED_SNIPER_ZOOM_IN=kbd:PGUP,2ndKbd:Z,mouse:WHLUP
PED_SNIPER_ZOOM_OUT=kbd:PGDN,2ndKbd:X,mouse:WHLDOWN
VEHICLE_ENTER_EXIT=kbd:ENTER,2ndKbd:F
CAMERA_CHANGE_VIEW_ALL_SITUATIONS=kbd:HOME,2ndKbd:V
PED_JUMPING=kbd:RCTRL,2ndKbd:SPC
PED_SPRINT=2ndKbd:LSHIFT,kbd:RSHIFT
PED_LOOKBEHIND=2ndKbd:CAPSLK,mouse:MIDDLE,kbd:PADINS
PED_DUCK=kbd:C
PED_ANSWER_PHONE=kbd:TAB
VEHICLE_FIREWEAPON=kbd:PADINS,2ndKbd:LCTRL,mouse:LEFT
VEHICLE_ACCELERATE=2ndKbd:W
VEHICLE_BRAKE=2ndKbd:S
VEHICLE_CHANGE_RADIO_STATION=kbd:INS,2ndKbd:R
VEHICLE_HORN=2ndKbd:LSHIFT,kbd:RSHIFT
TOGGLE_SUBMISSIONS=kbd:PLUS,2ndKbd:CAPSLK
VEHICLE_HANDBRAKE=kbd:RCTRL,2ndKbd:SPC,mouse:RIGHT
PED_1RST_PERSON_LOOK_LEFT=kbd:PADLEFT
PED_1RST_PERSON_LOOK_RIGHT=kbd:PADHOME
VEHICLE_LOOKLEFT=kbd:PADEND,2ndKbd:Q
VEHICLE_LOOKRIGHT=kbd:PADDOWN,2ndKbd:E
VEHICLE_LOOKBEHIND=mouse:MIDDLE
VEHICLE_TURRETLEFT=kbd:PADLEFT
VEHICLE_TURRETRIGHT=kbd:PAD5
VEHICLE_TURRETUP=kbd:PADPGUP,2ndKbd:UP
VEHICLE_TURRETDOWN=kbd:PADRIGHT,2ndKbd:DOWN
PED_CYCLE_TARGET_LEFT=kbd:[,2ndKbd:PADEND
PED_CYCLE_TARGET_RIGHT=2ndKbd:],kbd:PADDOWN
PED_CENTER_CAMERA_BEHIND_PLAYER=kbd:#
PED_LOCK_TARGET=kbd:DEL,mouse:RIGHT,2ndKbd:PADRIGHT
NETWORK_TALK=kbd:T
PED_1RST_PERSON_LOOK_UP=kbd:PADPGUP
PED_1RST_PERSON_LOOK_DOWN=kbd:PADUP
_CONTROLLERACTION_36=
TOGGLE_DPAD=
SWITCH_DEBUG_CAM_ON=
TAKE_SCREEN_SHOT=
SHOW_MOUSE_POINTER_TOGGLE=
UNKNOWN_ACTION=

`;

const revc_ini = (() => {
    const cached = localStorage.getItem('vcsky.revc.ini');
    if (cached) {
        return cached;
    }
    return revc_iniDefault;
})();

// Configurable mode UI
if (configurableMode) {
    const configPanel = document.getElementById('config-panel');
    const configLang = document.getElementById('config-lang');
    const configCheats = document.getElementById('config-cheats');
    const configFullscreen = document.getElementById('config-fullscreen');
    const configMaxFps = document.getElementById('config-max-fps');
    
    if (configPanel && configCheats && configFullscreen && configMaxFps) {
        // Show config panel
        configPanel.style.display = 'block';
        
        // Set initial values from URL params
        if (configLang) configLang.value = currentLanguage;
        configCheats.checked = cheatsEnabled;
        configFullscreen.checked = autoFullScreen;
        configMaxFps.value = maxFPS;
        
        // Update config panel labels with current language
        updateAllTranslations();
        
        // Language selector handler
        if (configLang) {
            configLang.addEventListener('change', (e) => {
                currentLanguage = e.target.value;
                updateGameDataForLanguage(currentLanguage);
                updateAllTranslations();
            });
        }
        
        // Update settings when changed
        configCheats.addEventListener('change', (e) => {
            cheatsEnabled = e.target.checked;
        });
        
        configFullscreen.addEventListener('change', (e) => {
            autoFullScreen = e.target.checked;
        });
        
        configMaxFps.addEventListener('input', (e) => {
            maxFPS = parseInt(e.target.value) || 0;
        });
    }
}