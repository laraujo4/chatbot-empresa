'use strict';

// leitor de qr code
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const express = require('express');
const { Client, LocalAuth, Buttons, List, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const path = require('path');

// pasta de sessão (pode ser sobrescrita por variável de ambiente)
const sessionPath = process.env.SESSION_PATH || '/data/session';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log('Criada pasta de sessão em', sessionPath);
}

// ---- controle de saudações diárias (persistente) ----
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

// pasta pública para servir a imagem do QR
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    console.log('Criada pasta pública em', publicDir);
}

let lastQr = null;
let qrWriteTimeout = null;

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'mili-bot',
        dataPath: path.join(__dirname, 'session')
    }),
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || puppeteer.executablePath() || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

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

client.on('qr', async qr => {
    try {
        console.log('🟨 Novo QR recebido — gerando imagem em /qr ...');
        try {
            qrcode.generate(qr, { small: true });
        } catch (err) {
            console.error('Erro ao gerar QR no terminal com qrcode-terminal:', err);
        }

        if (qrWriteTimeout) clearTimeout(qrWriteTimeout);
        qrWriteTimeout = setTimeout(async () => {
            try {
                if (lastQr && lastQr === qr) {
                    console.log('QR idêntico ao anterior — pulando regravação.');
                    return;
                }
                const opts = { type: 'png', width: 800, margin: 2, errorCorrectionLevel: 'M' };
                const buffer = await QRCode.toBuffer(qr, opts);
                const outPath = path.join(publicDir, 'qr.png');
                fs.writeFileSync(outPath, buffer);
                lastQr = qr;
                console.log('✅ QR image salva em /public/qr.png');
                console.log('🔗 Abra https://chatbot-empresa-production-30a4.up.railway.app/qr para escanear.');
            } catch (err) {
                console.error('Erro ao gerar PNG do QR:', err);
            }
        }, 300);
    } catch (err) {
        console.error('Erro no handler de qr:', err);
    }
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado com sucesso!');
});

client.on('auth_failure', msg => {
    console.error('Falha de autenticação:', msg);
});

client.on('disconnected', reason => {
    console.warn('Cliente desconectado:', reason);
});

client.initialize();

const delay = ms => new Promise(res => setTimeout(res, ms));
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

    console.log('🕛 Limpeza agendada para (hora local servidor):', proximaExecucaoUTC.toISOString());

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

async function sendMenu(from, contact) {
    try {
        const name = (contact && contact.pushname) ? contact.pushname : 'amigo';
        const firstName = name.split(' ')[0];
        await delay(1000);
        let chat = null;
        try {
            chat = await client.getChatById(from);
        } catch (e) {
            console.warn('sendMenu: não foi possível obter chat via client.getChatById():', e && e.message ? e.message : e);
        }
        if (chat && chat.sendStateTyping) {
            try { await chat.sendStateTyping(); } catch (e) { /* ignora */ }
        }
        await delay(1000);
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
    } catch (err) {
        console.error('Erro em sendMenu:', err);
    }
}

client.on('message', async msg => {
    try {
        if (msg.type && !['chat', 'text'].includes(msg.type)) return;

        const from = msg.from;
        if (!from || from.endsWith('@g.us') || from.endsWith('@broadcast')) return;

        let chat = null;
        try {
            chat = await msg.getChat();
        } catch (e) {
            console.warn('⚠️ Falha ao obter chat via msg.getChat():', e?.message || e);
        }

        if (foraDoHorario()) {
            if (!clientesAvisadosForaDoHorario.has(from)) {
                await client.sendMessage(from, '🕒 Não estamos atendendo no momento. Deixe sua mensagem e responderemos em breve!', { sendSeen: false });
                clientesAvisadosForaDoHorario.add(from);
            }
            return;
        }

        const raw = msg.body || '';
        const rawTrim = raw.trim();
        if (!rawTrim) return;

        const text = raw
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/g, ' ')
            .trim();

        const greetingsList = [
            'menu', 'teste', 'boa', 'boa noite', 'boa tarde', 'bom dia', 'boa dia',
            'oi', 'oii', 'ola', 'oi bom dia', 'oi boa tarde', 'boa tardr', 'oi boa noite',
            'oi, bom dia', 'oi, boa tarde', 'oi, boa noite', 'olá', 'olá bom dia',
            'olá boa tarde', 'olá boa noite', 'ola', 'olaa'
        ];

        const isGreeting = greetingsList.some(g => text.includes(g.replace(/á/g, 'a')));

        if (isGreeting) {
            if (hasGreetedToday(from)) {
                console.log('Já enviamos saudação hoje para', from);
                return;
            }
            const contact = await safeGetContact(msg);
            userCurrentOption.delete(from);
            await sendMenu(from, contact);
            markGreetedNow(from);
            return;
        }

        if (userCurrentOption.has(from)) {
            if (rawTrim === '4') {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(from, contact);
                markGreetedNow(from);
                return;
            }
            return;
        }

        if (rawTrim === '1') {
            userCurrentOption.set(from, '1');
            await delay(1000);
            try { await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '🛵 Entregamos nossos produtos fresquinhos em Praia Grande, Santos, São Vicente e Mongaguá!\n Para outras cidades, consulte disponibilidade.\n\nJunto com o seu pedido, informe também o seu *endereço (rua, número e bairro)*.', { sendSeen: false });
            await delay(1000);
            try { await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '📋 Aqui está o nosso cardápio!\n\nA taxa de entrega é de R$ 5,00, e elas são feitas das 8h às 17h! 😉', { sendSeen: false });
            try {
                const mediaPath = './Cardápio Empresa.jpg';
                if (fs.existsSync(mediaPath)) {
                    const media = MessageMedia.fromFilePath(mediaPath);
                    await client.sendMessage(from, media, { caption: '📋 Cardápio', sendSeen: false });
                } else {
                    console.warn('Arquivo de mídia não encontrado:', mediaPath);
                }
            } catch (err) {
                console.error('Erro ao enviar mídia:', err);
            }
            await client.sendMessage(from, 'Se quiser voltar ao menu inicial, digite 4', { sendSeen: false });
            return;
        }

        if (rawTrim === '2') {
            userCurrentOption.set(from, '2');
            await delay(1000);
            try { await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '🌽 Se você já é cliente, é só falar a quantidade de *sacos de milho* que você deseja encomendar.\n\nSe esse for o seu primeiro pedido, por favor, informe:\n📍 Endereço (rua, número, bairro e cidade)\n💵 *O valor do saco de milho é de R$ 90,00 (tamanho grande)*\n\n(Se quiser voltar ao menu inicial, digite 4)', { sendSeen: false });
            return;
        }

        if (rawTrim === '3') {
            userCurrentOption.set(from, '3');
            await delay(1000);
            try { await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '👤 Beleza!\nUm *atendente* vai te chamar em instantes.\n\nEnquanto isso, fica à vontade para enviar dúvidas ou pedidos 😊\n\nSe quiser voltar ao menu inicial, digite 4', { sendSeen: false });
            return;
        }

    } catch (err) {
        console.error('❌ Erro no processamento da mensagem:', err);
    }
});

const foraDoHorario = () => {
    const agora = new Date();
    const horaUTC = agora.getUTCHours();
    const horaBrasilia = (horaUTC - 3 + 24) % 24;
    return (horaBrasilia < 5 || horaBrasilia >= 23);
};

// --- Express health / status ---
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('OK'));

app.get('/qr', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) {
        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="10">
    <title>QR Code - WhatsApp</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f0f0; }
        img { max-width: 400px; border: 5px solid #25D366; border-radius: 10px; }
        h1 { color: #333; }
        p { color: #666; }
    </style>
</head>
<body>
    <h1>Escaneie este QR code para conectar o WhatsApp</h1>
    <img src="/qr.png" alt="QR Code">
    <p>Atualiza automaticamente quando um novo QR for emitido.</p>
</body>
</html>`;
        return res.send(html);
    } else {
        return res.send('QR ainda não gerado — aguarde alguns segundos e recarregue a página.');
    }
});

app.get('/qr.png', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) {
        res.sendFile(imgPath);
    } else {
        res.status(404).send('QR não disponível');
    }
});

app.listen(PORT, '0.0.0.0', () => console.log('HTTP server rodando na porta ' + PORT));

async function shutdown() {
    console.log('Shutdown iniciado — fechando client...');
    try {
        await client.destroy();
    } catch (e) {
        console.error('Erro ao destruir client:', e);
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', err => {
    console.error('Uncaught Exception:', err);
});
