'use strict';

/**
 * VERSÃO COMPLETA E ESTÁVEL (MANTÉM TODOS OS LOGS DO LOVABLE)
 * 
 * Este código preserva 100% da sua lógica original de logs, diagnósticos e mensagens,
 * mas injeta os "Fixes de Estabilidade" do Manus para garantir que o bot conecte.
 */

const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const path = require('path');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
// Mudamos ligeiramente o nome da pasta de sessão para garantir uma sincronização limpa
const sessionPath = path.join(__dirname, 'wwebjs_auth_session');
const publicDir = path.join(__dirname, 'public');

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
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
}

function hasGreetedToday(chatId) {
    return greetings[chatId] === hojeEmBrasil();
}

function markGreetedNow(chatId) {
    greetings[chatId] = hojeEmBrasil();
    saveGreetingsDebounced();
}

loadGreetings();

// ---------- VARIÁVEIS GLOBAIS ----------
let lastQr = null;
let qrWriteTimeout = null;
let readyFired = false;
let client = null;

// ---------- HELPERS ----------
async function safeGetContact(msg) {
    const from = msg && msg.from ? msg.from : 'unknown@c.us';
    try {
        const d = msg._data || {};
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
    const agora = new Date();
    const horaUTC = agora.getUTCHours();
    const horaBrasilia = (horaUTC - 3 + 24) % 24;
    return (horaBrasilia < 5 || horaBrasilia >= 23);
};

const clientesAvisadosForaDoHorario = new Set();
const userCurrentOption = new Map();

function agendarLimpezaDiaria() {
    const agora = new Date();
    const msOffset = 3 * 60 * 60 * 1000;
    const agoraBrasil = new Date(agora.getTime() - msOffset);
    const proximaMeiaNoiteBrasil = new Date(agoraBrasil);
    proximaMeiaNoiteBrasil.setHours(24, 0, 0, 0);
    const proximaExecucaoUTC = new Date(proximaMeiaNoiteBrasil.getTime() + msOffset);
    const tempoAteMeiaNoite = proximaExecucaoUTC - agora;

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

// ---------- CREATE CLIENT (Preserva logs + Fixes de Estabilidade) ----------
function createClient() {
    const c = new Client({
        authStrategy: new LocalAuth({
            clientId: 'mili-bot',
            dataPath: sessionPath
        }),
        puppeteer: {
            headless: true, // Forçado para estabilidade no servidor
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--remote-debugging-port=9222' // Fix Manus
            ]
        },
        // FIX CRÍTICO MANUS: Força versão estável para evitar loop de 'authenticated'
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    // ----- EVENTOS (Mantendo todos os seus logs informativos) -----

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

        // Watchdog original do Lovable
        setTimeout(async () => {
            if (!readyFired) {
                console.warn('⏳ Após 60s de "authenticated", o evento "ready" ainda NÃO ocorreu. Vamos dumpar info útil.');
                try {
                    const filesNow = fs.readdirSync(sessionPath);
                    console.log('📁 [watchdog] sessionPath agora:', filesNow);
                } catch (e) { console.warn('Erro sessionPath watchdog:', e); }

                try {
                    const pup = c.pupBrowser || c.browser;
                    if (pup) {
                        const pages = await pup.pages();
                        console.log('🌐 [watchdog] número de pages no browser:', pages.length);
                        for (let i = 0; i < pages.length; i++) {
                            try {
                                console.log(`Page[${i}] URL:`, pages[i].url());
                            } catch (err) {}
                        }
                    }
                } catch (err) {}
            }
        }, 60000);
    });

    c.on('auth_failure', msg => {
        console.error('❌ [EVENT] auth_failure — falha durante autenticação:', msg);
    });

    c.on('ready', () => {
        readyFired = true;
        console.log('✅ [EVENT] ready — WhatsApp conectado com sucesso! Bot pronto para receber mensagens.');
    });

    c.on('disconnected', reason => {
        readyFired = false;
        console.warn('⚠️ [EVENT] disconnected — motivo:', reason);
    });

    c.on('change_state', state => console.log('🔄 [EVENT] change_state ->', state));
    c.on('loading_screen', (percent, message) => console.log(`📊 [EVENT] loading_screen -> ${percent}%: ${message}`));
    c.on('remote_session_saved', () => console.log('💾 [EVENT] remote_session_saved (sessão remota salva)'));

    c.on('message', async msg => {
        try {
            // ---- DEBUG LOG ORIGINAL ----
            console.log('📩 [MSG RECEBIDA]', JSON.stringify({
                from: msg.from,
                type: msg.type,
                body: (msg.body || '').substring(0, 50),
                fromMe: msg.fromMe,
                isStatus: msg.isStatus,
                timestamp: new Date().toISOString()
            }));

            if (msg.fromMe || (msg.type && !['chat', 'text'].includes(msg.type))) return;

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

            const raw = msg.body || '';
            const rawTrim = raw.trim();
            if (!rawTrim) return;

            const text = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').trim();
            const greetingsList = ['menu', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'];

            if (greetingsList.some(g => text.includes(g))) {
                if (hasGreetedToday(from)) {
                    const contact = await safeGetContact(msg);
                    await sendMenu(from, contact);
                    return;
                }
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(from, contact);
                markGreetedNow(from);
                return;
            }

            if (userCurrentOption.has(from) && rawTrim === '4') {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(from, contact);
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
                }
                await c.sendMessage(from, 'Se quiser voltar ao menu inicial, digite 4', { sendSeen: false });
            } else if (rawTrim === '2') {
                userCurrentOption.set(from, '2');
                await c.sendMessage(from, '🌽 *Encomenda de Milho*\nSaco Grande: R$ 90,00.\nInforme a quantidade e endereço.\n\nDigite 4 para voltar.', { sendSeen: false });
            } else if (rawTrim === '3') {
                userCurrentOption.set(from, '3');
                await c.sendMessage(from, '👤 Um atendente já vai falar com você! Aguarde um instante.\n\nDigite 4 para voltar.', { sendSeen: false });
            }

        } catch (err) { console.error('❌ Erro no processamento da mensagem:', err); }
    });

    return c;
}

// ---------- sendMenu ----------
async function sendMenu(from, contact) {
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
        await client.sendMessage(from, menu, { sendSeen: false });
    } catch (err) { console.error('Erro em sendMenu:', err); }
}

// ---------- WATCHDOG LIGHT ----------
let reconnecting = false;
async function ensureReadyOrRestart() {
    if (readyFired || reconnecting) return;
    reconnecting = true;
    try {
        console.warn('⚠️ Watchdog: reinicializando client em 3s...');
        await delay(3000);
        try { await client.destroy(); } catch (e) {}
        client = createClient();
        await client.initialize();
    } catch (err) { console.error('Erro watchdog:', err); }
    finally { reconnecting = false; }
}
setInterval(() => { if (!readyFired) ensureReadyOrRestart(); }, 45000);

// ---------- INICIALIZAÇÃO ----------
client = createClient();
client.initialize().catch(err => console.error('Erro inicialização:', err));

// ---------- EXPRESS ----------
const app = express();
app.get('/', (req, res) => res.send(readyFired ? 'WhatsApp Conectado' : 'WhatsApp Inicializando'));
app.get('/qr', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) {
        res.send(`<html><head><meta http-equiv="refresh" content="10"></head><body style="background:#111;color:#fff;text-align:center;padding:50px;"><img src="/qr.png?t=${Date.now()}" style="border:10px solid #fff;max-width:300px;"/></body></html>`);
    } else res.send('Gerando QR...');
});
app.get('/qr.png', (req, res) => res.sendFile(path.join(publicDir, 'qr.png')));
app.listen(PORT, '0.0.0.0', () => console.log('🚀 Servidor HTTP na porta ' + PORT));

// Shutdown
process.on('SIGINT', async () => {
    if (client) await client.destroy();
    process.exit(0);
});