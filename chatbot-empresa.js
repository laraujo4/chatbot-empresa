'use strict';

/**
 * BOT WHATSAPP - PAMONHA E CIA
 * Versão corrigida e estável para Railway
 * 
 * Correções aplicadas:
 * 1. webVersionCache atualizado com URL estável
 * 2. Bug de referência nula em sendMenu corrigido
 * 3. Watchdog reescrito para não interferir com a inicialização
 * 4. Express static configurado corretamente
 * 5. Flags do Puppeteer otimizadas para Railway
 * 6. Lógica de reconexão mais segura
 */

const qrcode    = require('qrcode-terminal');
const QRCode    = require('qrcode');
const fs        = require('fs');
const express   = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path      = require('path');

// ---------- CONFIG ----------
const PORT        = process.env.PORT || 8080;
const sessionPath = path.join(__dirname, 'wwebjs_auth_session');
const publicDir   = path.join(__dirname, 'public');

if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log('Criada pasta de sessão em', sessionPath);
}
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    console.log('Criada pasta pública em', publicDir);
}

// ---------- PERSISTÊNCIA SAUDAÇÕES ----------
const greetingsFile = path.join(sessionPath, 'greetings.json');
let greetings = {};
let greetingsSaveTimeout = null;

function loadGreetings() {
    try {
        if (fs.existsSync(greetingsFile)) {
            const raw = fs.readFileSync(greetingsFile, 'utf8');
            greetings = JSON.parse(raw || '{}');
            console.log('✅ greetings carregado:', Object.keys(greetings).length, 'registros');
        }
    } catch (e) {
        console.warn('Não foi possível carregar greetings.json:', e);
        greetings = {};
    }
}

function saveGreetingsDebounced() {
    if (greetingsSaveTimeout) clearTimeout(greetingsSaveTimeout);
    greetingsSaveTimeout = setTimeout(() => {
        try {
            fs.writeFileSync(greetingsFile, JSON.stringify(greetings, null, 2), 'utf8');
        } catch (e) {
            console.error('Erro ao salvar greetings.json:', e);
        }
    }, 500);
}

function hojeEmBrasil() {
    const ms = Date.now() - (3 * 60 * 60 * 1000);
    const d  = new Date(ms);
    return d.toISOString().slice(0, 10);
}

function hasGreetedToday(chatId) { return greetings[chatId] === hojeEmBrasil(); }
function markGreetedNow(chatId)  { greetings[chatId] = hojeEmBrasil(); saveGreetingsDebounced(); }

loadGreetings();

// ---------- VARIÁVEIS GLOBAIS ----------
let lastQr          = null;
let qrWriteTimeout  = null;
let readyFired      = false;
let client          = null;
let initializingNow = false; // NOVO: evita sobreposição de inicializações

// ---------- HELPERS ----------
async function safeGetContact(msg) {
    const from = msg && msg.from ? msg.from : 'unknown@c.us';
    try {
        const d         = msg._data || {};
        const maybeName = d.notifyName || d.senderName || d.pushname || d.notify || d.authorName;
        if (maybeName && typeof maybeName === 'string' && maybeName.trim()) {
            return { pushname: maybeName.trim(), id: { _serialized: from } };
        }
    } catch (err) {
        console.warn('safeGetContact: falha ao ler nome de msg._data:', err);
    }
    try {
        const chat = await client.getChatById(from).catch(() => null);
        if (chat) {
            const chatName = chat.formattedTitle || chat.name || (chat.contact && (chat.contact.pushname || chat.contact.name));
            if (chatName && typeof chatName === 'string') {
                return { pushname: chatName.trim(), id: { _serialized: from } };
            }
        }
    } catch (err) {
        console.warn('safeGetContact: falha ao tentar via chat:', err);
    }
    return { pushname: 'amigo', id: { _serialized: from } };
}

const delay = ms => new Promise(res => setTimeout(res, ms));

const foraDoHorario = () => {
    const horaBrasilia = (new Date().getUTCHours() - 3 + 24) % 24;
    return (horaBrasilia < 5 || horaBrasilia >= 23);
};

const clientesAvisadosForaDoHorario = new Set();
const userCurrentOption             = new Map();

function agendarLimpezaDiaria() {
    const agora                  = new Date();
    const msOffset               = 3 * 60 * 60 * 1000;
    const agoraBrasil            = new Date(agora.getTime() - msOffset);
    const proximaMeiaNoiteBrasil = new Date(agoraBrasil);
    proximaMeiaNoiteBrasil.setHours(24, 0, 0, 0);
    const proximaExecucaoUTC = new Date(proximaMeiaNoiteBrasil.getTime() + msOffset);
    const tempoAteMeiaNoite  = proximaExecucaoUTC - agora;

    console.log('🕛 Limpeza agendada para (UTC):', proximaExecucaoUTC.toISOString());

    setTimeout(() => {
        clientesAvisadosForaDoHorario.clear();
        console.log('🧹 Lista de clientes fora do horário limpa!');
        setInterval(() => {
            clientesAvisadosForaDoHorario.clear();
            console.log('🧹 Lista de clientes fora do horário limpa automaticamente (diária)');
        }, 24 * 60 * 60 * 1000);
    }, tempoAteMeiaNoite);
}
agendarLimpezaDiaria();

// ---------- sendMenu ----------
// CORREÇÃO: agora recebe o client como parâmetro para evitar referência nula
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
    } catch (err) {
        console.error('Erro em sendMenu:', err);
    }
}

// ---------- CREATE CLIENT ----------
function createClient() {
    const c = new Client({
        authStrategy: new LocalAuth({
            clientId: 'mili-bot',
            dataPath: sessionPath
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',      // NOVO: essencial para Railway (container com 1 CPU)
                '--disable-gpu',
                '--disable-extensions',  // NOVO: reduz uso de memória
                '--disable-software-rasterizer' // NOVO: evita crash em ambientes sem GPU
            ]
        },
        // CORREÇÃO PRINCIPAL: URL estável e atualizada para evitar loop de QR/authenticated
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017424380-alpha.html',
        }
    });

    // ----- EVENTOS -----

    c.on('qr', async qr => {
        try {
            console.log('🟨 [EVENT] qr recebido — gerando imagem e QR no terminal');
            try { qrcode.generate(qr, { small: true }); } catch (err) { console.warn('qrcode-terminal falhou:', err); }

            if (qrWriteTimeout) clearTimeout(qrWriteTimeout);
            qrWriteTimeout = setTimeout(async () => {
                try {
                    if (lastQr && lastQr === qr) {
                        console.log('QR idêntico ao anterior — pulando regravação.');
                        return;
                    }
                    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 800, margin: 2 });
                    fs.writeFileSync(path.join(publicDir, 'qr.png'), buffer);
                    lastQr = qr;
                    console.log('✅ QR image salva em /public/qr.png');
                } catch (err) {
                    console.error('Erro ao gerar PNG do QR:', err);
                }
            }, 300);
        } catch (err) {
            console.error('Erro no handler de qr:', err);
        }
    });

    c.on('authenticated', () => {
        console.log('🔓 [EVENT] authenticated — credenciais aceitas e gravadas.');
        try {
            const files = fs.readdirSync(sessionPath);
            console.log('📁 Conteúdo da pasta de sessão:', files);
        } catch (e) {
            console.warn('Erro ao listar sessionPath:', e);
        }

        // Watchdog informativo — agora com 90s para dar tempo ao Railway
        setTimeout(async () => {
            if (!readyFired) {
                console.warn('⏳ Após 90s de "authenticated", o evento "ready" ainda NÃO ocorreu.');
                try {
                    const filesNow = fs.readdirSync(sessionPath);
                    console.log('📁 [watchdog] sessionPath agora:', filesNow);
                } catch (e) { console.warn('Erro sessionPath watchdog:', e); }
                try {
                    const pup   = c.pupBrowser || c.browser;
                    if (pup) {
                        const pages = await pup.pages();
                        console.log('🌐 [watchdog] número de pages no browser:', pages.length);
                        for (let i = 0; i < pages.length; i++) {
                            try { console.log(`Page[${i}] URL:`, pages[i].url()); } catch (err) {}
                        }
                    }
                } catch (err) {}
            }
        }, 90000); // CORREÇÃO: era 60s, agora 90s
    });

    c.on('auth_failure', msg => {
        console.error('❌ [EVENT] auth_failure:', msg);
        // Limpa a sessão corrompida para forçar novo QR no próximo start
        try {
            const sessionDir = path.join(sessionPath, 'session-mili-bot');
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log('🗑️ Sessão corrompida removida. Reinicie o bot para gerar novo QR.');
            }
        } catch (e) {
            console.warn('Não foi possível limpar sessão corrompida:', e);
        }
    });

    c.on('ready', () => {
        readyFired      = true;
        initializingNow = false;
        console.log('✅ [EVENT] ready — WhatsApp conectado! Bot pronto para receber mensagens.');
    });

    c.on('disconnected', reason => {
        readyFired = false;
        console.warn('⚠️ [EVENT] disconnected — motivo:', reason);
        // Agenda reconexão com delay para não sobrecarregar o Railway
        setTimeout(() => ensureReadyOrRestart(), 10000);
    });

    c.on('change_state',    state              => console.log('🔄 [EVENT] change_state ->', state));
    c.on('loading_screen',  (percent, message) => console.log(`📊 [EVENT] loading_screen -> ${percent}%: ${message}`));
    c.on('remote_session_saved', ()            => console.log('💾 [EVENT] remote_session_saved'));

    c.on('message', async msg => {
        try {
            console.log('📩 [MSG RECEBIDA]', JSON.stringify({
                from:      msg.from,
                type:      msg.type,
                body:      (msg.body || '').substring(0, 50),
                fromMe:    msg.fromMe,
                isStatus:  msg.isStatus,
                timestamp: new Date().toISOString()
            }));

            if (msg.fromMe) return;
            if (msg.type && !['chat', 'text'].includes(msg.type)) return;

            const from = msg.from;
            if (!from || from.endsWith('@g.us') || from.endsWith('@broadcast')) return;

            let chat = null;
            try { chat = await msg.getChat(); } catch (e) { console.warn('Falha ao obter chat:', e?.message || e); }

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

            const text         = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').trim();
            const greetingsList = ['menu', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'];

            if (greetingsList.some(g => text.includes(g))) {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                // CORREÇÃO: passa `c` para sendMenu em vez de usar a variável global `client`
                await sendMenu(c, from, contact);
                markGreetedNow(from);
                return;
            }

            // Opção 4: voltar ao menu
            if (userCurrentOption.has(from) && rawTrim === '4') {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(c, from, contact);
                markGreetedNow(from);
                return;
            }

            // --- OPÇÕES DO MENU ---
            if (rawTrim === '1') {
                userCurrentOption.set(from, '1');
                await delay(1000);
                if (chat) await chat.sendStateTyping();
                await delay(1000);
                await c.sendMessage(from, '🛵 Entregamos nossos produtos fresquinhos em Praia Grande, Santos, São Vicente e Mongaguá!\n\nEnvie seu *endereço completo* e seu pedido.', { sendSeen: false });

                const mediaPath = path.join(__dirname, 'Cardápio Empresa.jpg');
                if (fs.existsSync(mediaPath)) {
                    const media = MessageMedia.fromFilePath(mediaPath);
                    await c.sendMessage(from, media, { caption: '📋 Cardápio', sendSeen: false });
                } else {
                    console.warn('⚠️ Arquivo "Cardápio Empresa.jpg" não encontrado. Pulando envio de imagem.');
                }
                await c.sendMessage(from, 'Se quiser voltar ao menu inicial, digite 4', { sendSeen: false });

            } else if (rawTrim === '2') {
                userCurrentOption.set(from, '2');
                await c.sendMessage(from, '🌽 *Encomenda de Milho*\nSaco Grande: R$ 90,00.\nInforme a quantidade e endereço.\n\nDigite 4 para voltar.', { sendSeen: false });

            } else if (rawTrim === '3') {
                userCurrentOption.set(from, '3');
                await c.sendMessage(from, '👤 Um atendente já vai falar com você! Aguarde um instante.\n\nDigite 4 para voltar.', { sendSeen: false });
            }

        } catch (err) {
            console.error('❌ Erro no processamento da mensagem:', err);
        }
    });

    return c;
}

// ---------- WATCHDOG REESCRITO ----------
// CORREÇÃO: intervalo aumentado para 120s e proteção contra sobreposição de inicializações
let reconnecting = false;

async function ensureReadyOrRestart() {
    if (readyFired || reconnecting || initializingNow) return;
    reconnecting = true;
    console.warn('⚠️ Watchdog: client não está pronto. Reinicializando em 5s...');
    try {
        await delay(5000);
        try { await client.destroy(); } catch (e) { console.warn('Destroy falhou (ignorado):', e?.message); }
        await delay(2000);
        client = createClient();
        initializingNow = true;
        await client.initialize();
    } catch (err) {
        console.error('Erro no watchdog ao reinicializar:', err);
        initializingNow = false;
    } finally {
        reconnecting = false;
    }
}

// CORREÇÃO: era 45s — muito curto para o Railway. Agora 120s.
setInterval(() => {
    if (!readyFired && !initializingNow) ensureReadyOrRestart();
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

// CORREÇÃO: servir pasta public como static (necessário para /qr.png funcionar corretamente)
app.use(express.static(publicDir));

app.get('/', (req, res) => {
    res.send(readyFired ? '✅ WhatsApp Conectado' : '⏳ WhatsApp Inicializando... Acesse /qr para escanear o QR Code');
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
                <p style="color:#aaa;">A página atualiza automaticamente a cada 10 segundos</p>
                <img src="/qr.png?t=${Date.now()}" style="border:10px solid #fff;max-width:300px;border-radius:8px;"/>
                <p style="color:#aaa;font-size:12px;">Se o QR sumir, o bot conectou com sucesso!</p>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
            <head><meta http-equiv="refresh" content="5"><title>Aguardando QR...</title></head>
            <body style="background:#111;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h2>⏳ Gerando QR Code...</h2>
                <p>Aguarde alguns segundos e a página irá atualizar automaticamente.</p>
            </body>
            </html>
        `);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log('🚀 Servidor HTTP na porta ' + PORT));

// ---------- SHUTDOWN GRACIOSO ----------
process.on('SIGINT', async () => {
    console.log('\n🛑 Encerrando bot...');
    if (client) {
        try { await client.destroy(); } catch (e) {}
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM recebido. Encerrando bot...');
    if (client) {
        try { await client.destroy(); } catch (e) {}
    }
    process.exit(0);
});