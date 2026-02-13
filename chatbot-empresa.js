'use strict';

const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const path = require('path');

const sessionPath = process.env.SESSION_PATH || path.join(__dirname, 'session_data');
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

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    console.log('Criada pasta pública em', publicDir);
}

let lastQr = null;
let qrWriteTimeout = null;

// ======== CORREÇÃO PRINCIPAL: webVersionCache ========
// Sem isso, o evento 'ready' pode nunca disparar após 'authenticated'
const client = new Client({
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
            '--disable-gpu'
        ]
    },
    // CORREÇÃO: Força uma versão estável do WhatsApp Web
    // Isso resolve o problema de ficar preso em "Aguardando sincronização (ready)..."
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/nicollemorar/nicollemorar/refs/heads/main/nicollemorar-whatsapp-2.2412.54-beta.html',
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

// ---------- EVENTOS DO CLIENTE ----------

client.on('qr', async qr => {
    try {
        console.log('🟨 Novo QR recebido — gerando imagem em /qr ...');
        try {
            qrcode.generate(qr, { small: true });
        } catch (err) {
            console.error('Erro ao gerar QR no terminal:', err);
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
            } catch (err) {
                console.error('Erro ao gerar PNG do QR:', err);
            }
        }, 300);
    } catch (err) {
        console.error('Erro no handler de qr:', err);
    }
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado com sucesso! Bot pronto para receber mensagens.');
});

client.on('authenticated', () => {
    console.log('🔓 Autenticado com sucesso! Aguardando sincronização (ready)...');
});

client.on('auth_failure', msg => {
    console.error('❌ Falha de autenticação:', msg);
});

client.on('disconnected', reason => {
    console.warn('⚠️ Cliente desconectado:', reason);
});

// CORREÇÃO: Registrar TODOS os handlers ANTES de inicializar
// (os handlers de message estão definidos abaixo, antes do initialize)

// ---------- LÓGICA DO CHATBOT ----------

const delay = ms => new Promise(res => setTimeout(res, ms));
const clientesAvisadosForaDoHorario = new Set();
const userCurrentOption = new Map();

const foraDoHorario = () => {
    const agora = new Date();
    const horaUTC = agora.getUTCHours();
    const horaBrasilia = (horaUTC - 3 + 24) % 24;
    return (horaBrasilia < 5 || horaBrasilia >= 23);
};

function agendarLimpezaDiaria() {
    const agora = new Date();
    const msOffset = 3 * 60 * 60 * 1000;
    const agoraBrasil = new Date(agora.getTime() - msOffset);
    const proximaMeiaNoiteBrasil = new Date(agoraBrasil);
    proximaMeiaNoiteBrasil.setHours(24, 0, 0, 0);
    const proximaExecucaoUTC = new Date(proximaMeiaNoiteBrasil.getTime() + msOffset);
    const tempoAteMeiaNoite = proximaExecucaoUTC - agora;

    console.log('🕛 Limpeza agendada para:', proximaExecucaoUTC.toISOString());

    setTimeout(() => {
        clientesAvisadosForaDoHorario.clear();
        console.log('🧹 Lista de clientes fora do horário limpa!');
        setInterval(() => {
            clientesAvisadosForaDoHorario.clear();
            console.log('🧹 Lista limpa automaticamente (diária)');
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
            console.warn('sendMenu: não foi possível obter chat:', e && e.message ? e.message : e);
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
        // CORREÇÃO: sendSeen: false evita crash de sincronização
        await client.sendMessage(from, menu, { sendSeen: false });
        console.log('📤 Menu enviado para', from);
    } catch (err) {
        console.error('Erro em sendMenu:', err);
    }
}

// ======== HANDLER DE MENSAGENS ========
client.on('message', async msg => {
    try {
        // ---- DEBUG LOG ----
        console.log('📩 [MSG RECEBIDA]', JSON.stringify({
            from: msg.from,
            type: msg.type,
            body: (msg.body || '').substring(0, 50),
            fromMe: msg.fromMe,
            isStatus: msg.isStatus,
            timestamp: new Date().toISOString()
        }));

        // CORREÇÃO: Ignorar mensagens próprias e status
        if (msg.fromMe) {
            console.log('⏭️ Ignorando: mensagem própria');
            return;
        }
        if (msg.isStatus) {
            console.log('⏭️ Ignorando: status/story');
            return;
        }

        // Aceita tipos 'chat' e 'text'
        if (msg.type && !['chat', 'text'].includes(msg.type)) {
            console.log('⏭️ Ignorando: tipo não suportado:', msg.type);
            return;
        }

        const from = msg.from;
        if (!from) {
            console.log('⏭️ Ignorando: sem remetente');
            return;
        }

        // CORREÇÃO: Aceitar @c.us e @lid, rejeitar grupos e broadcast
        if (from.endsWith('@g.us') || from.endsWith('@broadcast')) {
            console.log('⏭️ Ignorando: grupo ou broadcast');
            return;
        }

        let chat = null;
        try {
            chat = await msg.getChat();
        } catch (e) {
            console.warn('⚠️ Falha ao obter chat:', e?.message || e);
        }

        // Fora do horário
        if (foraDoHorario()) {
            console.log('🕒 Fora do horário para', from);
            if (!clientesAvisadosForaDoHorario.has(from)) {
                await client.sendMessage(from, '🕒 Não estamos atendendo no momento. Deixe sua mensagem e responderemos em breve!', { sendSeen: false });
                clientesAvisadosForaDoHorario.add(from);
            }
            return;
        }

        const raw = msg.body || '';
        const rawTrim = raw.trim();
        if (!rawTrim) {
            console.log('⏭️ Ignorando: mensagem vazia');
            return;
        }

        const text = raw
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/g, ' ')
            .trim();

        console.log('🔍 Texto normalizado:', text, '| userCurrentOption:', userCurrentOption.get(from) || 'nenhum', '| hasGreetedToday:', hasGreetedToday(from));

        const greetingsList = [
            'menu', 'teste', 'boa', 'boa noite', 'boa tarde', 'bom dia', 'boa dia',
            'oi', 'ola', 'oi bom dia', 'oi boa tarde', 'boa tardr', 'oi boa noite',
            'oi, bom dia', 'oi, boa tarde', 'oi, boa noite', 'olá', 'olá bom dia',
            'olá boa tarde', 'olá boa noite', 'ola', 'olaa'
        ];

        const isGreeting = greetingsList.some(g => text.includes(g.replace(/á/g, 'a')));
        console.log('👋 É saudação?', isGreeting);

        if (isGreeting) {
            if (hasGreetedToday(from)) {
                console.log('ℹ️ Já saudou hoje, reenviando menu mesmo assim');
                // CORREÇÃO: Reenviar o menu mesmo se já saudou, para não deixar o usuário sem resposta
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

        // Submenu - voltar ao menu
        if (userCurrentOption.has(from)) {
            console.log('📂 Usuário em submenu:', userCurrentOption.get(from));
            if (rawTrim === '4') {
                const contact = await safeGetContact(msg);
                userCurrentOption.delete(from);
                await sendMenu(from, contact);
                markGreetedNow(from);
                return;
            }
            // Dentro de um submenu, aceitar texto livre (pedidos, endereços, etc.)
            console.log('💬 Texto livre no submenu de', from);
            return;
        }

        // --- Opções do menu principal ---
        if (rawTrim === '1') {
            console.log('✅ Opção 1 selecionada por', from);
            userCurrentOption.set(from, '1');
            await delay(1000);
            try { if (chat) await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '🛵 Entregamos nossos produtos fresquinhos em Praia Grande, Santos, São Vicente e Mongaguá! Para outras cidades, consulte disponibilidade.\n\nJunto com o seu pedido, informe também o seu *endereço (rua, número e bairro)*.', { sendSeen: false });
            await delay(1000);
            await client.sendMessage(from, '📋 Aqui está o nosso cardápio!\n\nA taxa de entrega é de R$ 5,00, e elas são feitas das 8h às 17h! 😉', { sendSeen: false });

            try {
                const mediaPath = path.join(__dirname, 'Cardápio Empresa.jpg');
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
            console.log('✅ Opção 2 selecionada por', from);
            userCurrentOption.set(from, '2');
            await delay(1000);
            try { if (chat) await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '🌽 Se você já é cliente, é só falar a quantidade de *sacos de milho* que você deseja encomendar.\n\nSe esse for o seu primeiro pedido, por favor, informe:\n📍 Endereço (rua, número, bairro e cidade)\n💵 *O valor do saco de milho é de R$ 90,00 (tamanho grande)*\n\n(Se quiser voltar ao menu inicial, digite 4)', { sendSeen: false });
            return;
        }

        if (rawTrim === '3') {
            console.log('✅ Opção 3 selecionada por', from);
            userCurrentOption.set(from, '3');
            await delay(1000);
            try { if (chat) await chat.sendStateTyping(); } catch (e) { /* ignora */ }
            await delay(1000);
            await client.sendMessage(from, '👤 Beleza!\nUm *atendente* vai te chamar em instantes.\n\nEnquanto isso, fica à vontade para enviar dúvidas ou pedidos 😊\n\nSe quiser voltar ao menu inicial, digite 4', { sendSeen: false });
            return;
        }

        // CORREÇÃO: Fallback - mensagem não reconhecida no menu principal
        console.log('❓ Mensagem não reconhecida de', from, ':', rawTrim);
        const contact = await safeGetContact(msg);
        await client.sendMessage(from, '🤔 Não entendi sua mensagem. Digite *menu* para ver as opções disponíveis!', { sendSeen: false });

    } catch (err) {
        console.error('❌ Erro no processamento da mensagem:', err);
    }
});

// IMPORTANTE: initialize() DEPOIS de registrar todos os handlers
console.log('🚀 Iniciando cliente WhatsApp...');
client.initialize().catch(err => {
    console.error('Erro ao inicializar o cliente:', err);
});

// --- Express health / status ---
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Chatbot Status: Online'));

app.get('/qr', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) {
        const html = `<html>
<head><title>WhatsApp QR Code</title><meta http-equiv="refresh" content="10"></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff;font-family:sans-serif;">
<div style="text-align:center">
<h3>Escaneie este QR code para conectar o WhatsApp</h3>
<img src="/qr.png?t=${Date.now()}" style="max-width:90vw;border:10px solid white;border-radius:10px;"/>
<p style="opacity:.7">Atualiza automaticamente a cada 10 segundos.</p>
</div>
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

app.listen(PORT, '0.0.0.0', () => console.log('🚀 Servidor HTTP rodando na porta ' + PORT));

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
