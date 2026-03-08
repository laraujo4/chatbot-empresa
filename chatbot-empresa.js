'use strict';

/**
 * BOT WHATSAPP - PAMONHA E CIA
 * Versão estável para Railway
 *
 * Correções aplicadas:
 * 1. webVersionCache com URL estável (resolve loop de QR)
 * 2. Filtro de msg.type corrigido (resolvia zero respostas)
 * 3. Ping keepAlive a cada 30s (evita WebSocket zumbi)
 * 4. sendMenu usa `c` local, não a variável global `client`
 * 5. Watchdog com intervalo seguro (120s) e flag initializingNow
 * 6. Limpeza de sessão corrompida no auth_failure
 * 7. Reconexão automática no evento disconnected
 * 8. Flags do Puppeteer otimizadas para Railway
 * 9. SIGTERM tratado para shutdown limpo
 * 10. CORREÇÃO: destroyClient() robusto — mata o browser diretamente
 *     antes de chamar destroy(), evitando ProtocolError: Target closed
 */

const qrcode  = require('qrcode-terminal');
const QRCode  = require('qrcode');
const fs      = require('fs');
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path    = require('path');

// ---------- CONFIG ----------
const PORT        = process.env.PORT || 8080;
const sessionPath = path.join(__dirname, 'wwebjs_auth_session');
const publicDir   = path.join(__dirname, 'public');

if (!fs.existsSync(sessionPath)) { fs.mkdirSync(sessionPath, { recursive: true }); }
if (!fs.existsSync(publicDir))   { fs.mkdirSync(publicDir,   { recursive: true }); }

// ---------- PERSISTÊNCIA SAUDAÇÕES ----------
const greetingsFile = path.join(sessionPath, 'greetings.json');
let greetings = {};
let greetingsSaveTimeout = null;

function loadGreetings() {
    try {
        if (fs.existsSync(greetingsFile)) {
            greetings = JSON.parse(fs.readFileSync(greetingsFile, 'utf8') || '{}');
            console.log('✅ greetings carregado:', Object.keys(greetings).length, 'registros');
        }
    } catch (e) { console.warn('Não foi possível carregar greetings.json:', e); greetings = {}; }
}

function saveGreetingsDebounced() {
    if (greetingsSaveTimeout) clearTimeout(greetingsSaveTimeout);
    greetingsSaveTimeout = setTimeout(() => {
        try { fs.writeFileSync(greetingsFile, JSON.stringify(greetings, null, 2), 'utf8'); }
        catch (e) { console.error('Erro ao salvar greetings.json:', e); }
    }, 500);
}

function hojeEmBrasil() {
    return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function hasGreetedToday(chatId) { return greetings[chatId] === hojeEmBrasil(); }
function markGreetedNow(chatId)  { greetings[chatId] = hojeEmBrasil(); saveGreetingsDebounced(); }

loadGreetings();

// ---------- VARIÁVEIS GLOBAIS ----------
let lastQr          = null;
let qrWriteTimeout  = null;
let readyFired      = false;
let client          = null;
let initializingNow = false;
let keepAliveTimer  = null;

// ---------- HELPERS ----------
async function safeGetContact(msg) {
    const from = msg?.from ?? 'unknown@c.us';
    try {
        const d         = msg._data || {};
        const maybeName = d.notifyName || d.senderName || d.pushname || d.notify || d.authorName;
        if (maybeName && typeof maybeName === 'string' && maybeName.trim())
            return { pushname: maybeName.trim(), id: { _serialized: from } };
    } catch (e) { console.warn('safeGetContact _data falhou:', e); }

    try {
        const chat = await client.getChatById(from).catch(() => null);
        if (chat) {
            const n = chat.formattedTitle || chat.name || chat.contact?.pushname || chat.contact?.name;
            if (n) return { pushname: n.trim(), id: { _serialized: from } };
        }
    } catch (e) { console.warn('safeGetContact getChatById falhou:', e); }

    return { pushname: 'amigo', id: { _serialized: from } };
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// Promise que resolve após `ms` milissegundos — usada para timeouts em operações críticas
const withTimeout = (promise, ms, label) =>
    Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms)
        )
    ]);

const foraDoHorario = () => {
    const h = (new Date().getUTCHours() - 3 + 24) % 24;
    return h < 5 || h >= 23;
};

const clientesAvisadosForaDoHorario = new Set();
const userCurrentOption             = new Map();

function agendarLimpezaDiaria() {
    const agora   = new Date();
    const offset  = 3 * 60 * 60 * 1000;
    const brasil  = new Date(agora.getTime() - offset);
    const proxima = new Date(brasil); proxima.setHours(24, 0, 0, 0);
    const ms      = (proxima.getTime() + offset) - agora.getTime();
    console.log('🕛 Limpeza diária agendada para daqui', Math.round(ms / 60000), 'minutos');
    setTimeout(() => {
        clientesAvisadosForaDoHorario.clear();
        console.log('🧹 Lista fora do horário limpa!');
        setInterval(() => {
            clientesAvisadosForaDoHorario.clear();
            console.log('🧹 Lista fora do horário limpa (rotina diária)');
        }, 24 * 60 * 60 * 1000);
    }, ms);
}
agendarLimpezaDiaria();

// ---------- DESTROY ROBUSTO ----------
// CORREÇÃO: em vez de só chamar client.destroy() (que lança ProtocolError quando
// o browser já fechou), esta função tenta encerrar o browser diretamente primeiro,
// depois tenta o destroy() com timeout, e ignora qualquer erro em ambos os passos.
async function destroyClient(c) {
    if (!c) return;

    // Passo 1: tenta fechar o browser diretamente (sem passar pelo CDP)
    try {
        const browser = c.pupBrowser || c.browser || c.pupPage?.browser?.();
        if (browser) {
            console.log('🔫 Fechando browser diretamente...');
            await withTimeout(browser.close(), 5000, 'browser.close');
            console.log('✅ Browser fechado com sucesso.');
        }
    } catch (e) {
        console.warn('⚠️ browser.close() falhou (ignorado):', e?.message);
    }

    // Passo 2: tenta o destroy() normal com timeout de segurança
    try {
        await withTimeout(c.destroy(), 8000, 'client.destroy');
        console.log('✅ client.destroy() concluído.');
    } catch (e) {
        // ProtocolError, Target closed, Timeout — todos são esperados aqui
        console.warn('⚠️ client.destroy() ignorado:', e?.message);
    }

    await delay(1500); // Pequena pausa para o SO liberar recursos
}

// ---------- KEEP-ALIVE ----------
function startKeepAlive(c) {
    stopKeepAlive();
    keepAliveTimer = setInterval(async () => {
        if (!readyFired) return;
        try {
            const state = await c.getState();
            console.log('💓 keepAlive — estado:', state);
            if (state !== 'CONNECTED') {
                console.warn('⚠️ keepAlive detectou estado não-CONNECTED:', state, '— reconectando');
                readyFired = false;
                ensureReadyOrRestart();
            }
        } catch (e) {
            console.warn('⚠️ keepAlive falhou — reconectando:', e?.message);
            readyFired = false;
            ensureReadyOrRestart();
        }
    }, 30 * 1000);
    console.log('💓 keepAlive iniciado (intervalo: 30s)');
}

function stopKeepAlive() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

// ---------- sendMenu ----------
async function sendMenu(c, from, contact) {
    try {
        const firstName = (contact.pushname || 'amigo').split(' ')[0];
        const menu = [
            'Olá, ' + firstName + '! Seja bem-vindo à *Pamonha e Cia* 🌽',
            'Sou seu assistente virtual!',
            '',
            'Por favor, escolha uma opção *(digite apenas o número)*:',
            '',
            '1️⃣ Fazer um pedido',
            '2️⃣ Encomendar milho',
            '3️⃣ Falar com um atendente'
        ].join('\n');
        await c.sendMessage(from, menu, { sendSeen: false });
    } catch (err) { console.error('Erro em sendMenu:', err); }
}

// ---------- CREATE CLIENT ----------
function createClient() {
    const c = new Client({
        authStrategy: new LocalAuth({ clientId: 'mili-bot', dataPath: sessionPath }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017424380-alpha.html',
        }
    });

    c.on('qr', async qr => {
        console.log('🟨 [EVENT] qr recebido');
        try { qrcode.generate(qr, { small: true }); } catch (e) {}
        if (qrWriteTimeout) clearTimeout(qrWriteTimeout);
        qrWriteTimeout = setTimeout(async () => {
            try {
                if (lastQr === qr) return;
                const buf = await QRCode.toBuffer(qr, { type: 'png', width: 800, margin: 2 });
                fs.writeFileSync(path.join(publicDir, 'qr.png'), buf);
                lastQr = qr;
                console.log('✅ QR salvo em /public/qr.png');
            } catch (e) { console.error('Erro ao salvar QR PNG:', e); }
        }, 300);
    });

    c.on('authenticated', () => {
        console.log('🔓 [EVENT] authenticated');
        setTimeout(async () => {
            if (readyFired) return;
            console.warn('⏳ 90s após "authenticated" sem "ready". Diagnóstico:');
            try { console.log('📁 sessionPath:', fs.readdirSync(sessionPath)); } catch (e) {}
            try {
                const pup = c.pupBrowser || c.browser;
                if (pup) {
                    const pages = await pup.pages();
                    console.log('🌐 pages abertas:', pages.length);
                    for (const p of pages) { try { console.log('  -', p.url()); } catch (e) {} }
                }
            } catch (e) {}
        }, 90000);
    });

    c.on('auth_failure', msg => {
        console.error('❌ [EVENT] auth_failure:', msg);
        try {
            const sessionDir = path.join(sessionPath, 'session-mili-bot');
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log('🗑️ Sessão corrompida removida. Reinicie para gerar novo QR.');
            }
        } catch (e) { console.warn('Não foi possível limpar sessão:', e); }
    });

    c.on('ready', () => {
        readyFired      = true;
        initializingNow = false;
        console.log('✅ [EVENT] ready — Bot pronto para receber mensagens!');
        startKeepAlive(c);
    });

    c.on('disconnected', reason => {
        readyFired = false;
        stopKeepAlive();
        console.warn('⚠️ [EVENT] disconnected:', reason);
        setTimeout(() => ensureReadyOrRestart(), 10000);
    });

    c.on('change_state',         s      => console.log('🔄 [EVENT] change_state ->', s));
    c.on('loading_screen',       (p, m) => console.log(`📊 [EVENT] loading_screen -> ${p}%: ${m}`));
    c.on('remote_session_saved', ()     => console.log('💾 [EVENT] remote_session_saved'));

    c.on('message', async msg => {
        try {
            console.log('📩 [MSG]', JSON.stringify({
                from:      msg.from,
                type:      msg.type,
                body:      (msg.body || '').substring(0, 50),
                fromMe:    msg.fromMe,
                timestamp: new Date().toISOString()
            }));

            if (msg.fromMe) return;
            const tiposDescartados = ['image', 'video', 'audio', 'ptt', 'sticker', 'document', 'location', 'vcard', 'revoked'];
            if (msg.type && tiposDescartados.includes(msg.type)) return;

            const from = msg.from;
            if (!from || from.endsWith('@g.us') || from.endsWith('@broadcast')) return;

            let chat = null;
            try { chat = await msg.getChat(); } catch (e) { console.warn('Falha ao obter chat:', e?.message); }

            if (foraDoHorario()) {
                if (!clientesAvisadosForaDoHorario.has(from)) {
                    await c.sendMessage(from, '🕒 Não estamos atendendo no momento. Deixe sua mensagem e responderemos em breve!', { sendSeen: false });
                    clientesAvisadosForaDoHorario.add(from);
                }
                return;
            }

            const raw     = msg.body || '';
            const rawTrim = raw.trim();
            if (!rawTrim) return;

            const text = raw.toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^\w\s]/g, ' ')
                .trim();

            const greetingsList = ['menu', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'];

            if (greetingsList.some(g => text.includes(g))) {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(c, from, contact);
                markGreetedNow(from);
                return;
            }

            if (userCurrentOption.has(from) && rawTrim === '4') {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(c, from, contact);
                markGreetedNow(from);
                return;
            }

            if (rawTrim === '1') {
                userCurrentOption.set(from, '1');
                await delay(1000);
                if (chat) await chat.sendStateTyping();
                await delay(1000);
                await c.sendMessage(from,
                    '🛵 Entregamos nossos produtos fresquinhos em Praia Grande, Santos, São Vicente e Mongaguá!\n\nEnvie seu *endereço completo* e seu pedido.',
                    { sendSeen: false });

                const mediaPath = path.join(__dirname, 'Cardápio Empresa.jpg');
                if (fs.existsSync(mediaPath)) {
                    const media = MessageMedia.fromFilePath(mediaPath);
                    await c.sendMessage(from, media, { caption: '📋 Cardápio', sendSeen: false });
                } else {
                    console.warn('⚠️ "Cardápio Empresa.jpg" não encontrado — pulando imagem.');
                }
                await c.sendMessage(from, 'Se quiser voltar ao menu inicial, digite 4', { sendSeen: false });

            } else if (rawTrim === '2') {
                userCurrentOption.set(from, '2');
                await c.sendMessage(from,
                    '🌽 *Encomenda de Milho*\nSaco Grande: R$ 90,00.\nInforme a quantidade e endereço.\n\nDigite 4 para voltar.',
                    { sendSeen: false });

            } else if (rawTrim === '3') {
                userCurrentOption.set(from, '3');
                await c.sendMessage(from,
                    '👤 Um atendente já vai falar com você! Aguarde um instante.\n\nDigite 4 para voltar.',
                    { sendSeen: false });
            }

        } catch (err) { console.error('❌ Erro ao processar mensagem:', err); }
    });

    return c;
}

// ---------- WATCHDOG ----------
let reconnecting = false;

async function ensureReadyOrRestart() {
    if (readyFired || reconnecting || initializingNow) return;
    reconnecting = true;
    console.warn('⚠️ Watchdog: encerrando client atual e reinicializando...');
    stopKeepAlive();

    const oldClient = client;
    client = null; // Limpa referência global imediatamente

    try {
        // CORREÇÃO: usa destroyClient() robusto em vez de client.destroy() direto
        await destroyClient(oldClient);

        console.log('🔄 Criando novo client...');
        client = createClient();
        initializingNow = true;
        await client.initialize();

    } catch (err) {
        console.error('❌ Erro crítico no watchdog após destroy:', err?.message);
        initializingNow = false;
        // Agenda nova tentativa em 30s em vez de travar
        setTimeout(() => { reconnecting = false; ensureReadyOrRestart(); }, 30000);
        return;
    }

    reconnecting = false;
}

setInterval(() => {
    if (!readyFired && !initializingNow && !reconnecting) ensureReadyOrRestart();
}, 120000);

// ---------- INICIALIZAÇÃO ----------
client = createClient();
initializingNow = true;
client.initialize().catch(err => {
    console.error('Erro na inicialização:', err);
    initializingNow = false;
});

// ---------- EXPRESS ----------
const app = express();
app.use(express.static(publicDir));

app.get('/', (req, res) => {
    res.send(readyFired
        ? '✅ WhatsApp Conectado — Bot ativo!'
        : '⏳ Inicializando... Acesse <a href="/qr">/qr</a> para escanear o QR Code');
});

app.get('/qr', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) {
        res.send(`
            <html>
            <head>
                <meta http-equiv="refresh" content="10">
                <title>QR Code - Pamonha e Cia Bot</title>
            </head>
            <body style="background:#111;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h2>📱 Escaneie o QR Code no WhatsApp</h2>
                <p style="color:#aaa;">Atualiza automaticamente a cada 10 segundos</p>
                <img src="/qr.png?t=${Date.now()}" style="border:10px solid #fff;max-width:300px;border-radius:8px;"/>
                <p style="color:#aaa;font-size:12px;">Se o QR sumir, o bot conectou com sucesso!</p>
            </body>
            </html>`);
    } else {
        res.send(`
            <html>
            <head><meta http-equiv="refresh" content="5"><title>Aguardando QR...</title></head>
            <body style="background:#111;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h2>⏳ Gerando QR Code...</h2>
                <p>Aguarde alguns segundos, a página atualiza automaticamente.</p>
            </body>
            </html>`);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log('🚀 Servidor HTTP na porta', PORT));

// ---------- SHUTDOWN LIMPO ----------
async function shutdown(signal) {
    console.log(`\n🛑 ${signal} recebido. Encerrando...`);
    stopKeepAlive();
    await destroyClient(client);
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));