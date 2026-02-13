'use strict';

/**
 * CÓDIGO CORRIGIDO - WHATSAPP CHATBOT
 * Ajustes realizados:
 * 1. Adicionado evento 'loading_screen' para monitorar o progresso.
 * 2. Adicionado 'remote-debugging-port' nos args do Puppeteer (ajuda na estabilidade).
 * 3. Implementada lógica de reconexão automática.
 * 4. Refatorada a obtenção de contato para ser mais resiliente.
 * 5. Corrigida a lógica de saudações e fluxo de menus.
 */

const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');

// --- Configurações de Pastas ---
const sessionPath = process.env.SESSION_PATH || path.join(__dirname, 'session_data');
const publicDir = path.join(__dirname, 'public');

[sessionPath, publicDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Pasta criada: ${dir}`);
    }
});

// --- Controle de Saudações Diárias ---
const greetingsFile = path.join(sessionPath, 'greetings.json');
let greetings = {};
let greetingsSaveTimeout = null;

function loadGreetings() {
    try {
        if (fs.existsSync(greetingsFile)) {
            const raw = fs.readFileSync(greetingsFile, 'utf8');
            greetings = JSON.parse(raw || '{}');
            console.log('✅ Greetings carregado:', Object.keys(greetings).length, 'registros');
        }
    } catch (e) {
        console.warn('⚠️ Erro ao carregar greetings.json, iniciando vazio.');
        greetings = {};
    }
}

function saveGreetingsDebounced() {
    if (greetingsSaveTimeout) clearTimeout(greetingsSaveTimeout);
    greetingsSaveTimeout = setTimeout(() => {
        try {
            fs.writeFileSync(greetingsFile, JSON.stringify(greetings, null, 2), 'utf8');
        } catch (e) {
            console.error('❌ Erro ao salvar greetings.json:', e);
        }
    }, 1000);
}

function hojeEmBrasil() {
    // Ajuste simples para fuso Brasil (UTC-3)
    const d = new Date(new Date().getTime() - (3 * 60 * 60 * 1000));
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

// --- Inicialização do Cliente WhatsApp ---
let lastQr = null;
let qrWriteTimeout = null;

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
            '--disable-gpu',
            '--remote-debugging-port=9222' // Ajuda na estabilidade do Chrome
        ]
    }
});

// --- Eventos do Cliente ---

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Carregando: ${percent}% - ${message}`);
});

client.on('qr', async qr => {
    console.log('🟨 Novo QR Code gerado. Escaneie no terminal ou via navegador.');
    qrcode.generate(qr, { small: true });

    if (qrWriteTimeout) clearTimeout(qrWriteTimeout);
    qrWriteTimeout = setTimeout(async () => {
        try {
            if (lastQr === qr) return;
            const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 800, margin: 2 });
            fs.writeFileSync(path.join(publicDir, 'qr.png'), buffer);
            lastQr = qr;
            console.log('✅ Imagem do QR Code atualizada em /public/qr.png');
        } catch (err) {
            console.error('❌ Erro ao salvar imagem do QR:', err);
        }
    }, 500);
});

client.on('authenticated', () => {
    console.log('🔓 Autenticado com sucesso! Sincronizando dados...');
});

client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
});

client.on('ready', () => {
    console.log('🚀 WhatsApp conectado e pronto para uso!');
});

client.on('disconnected', async (reason) => {
    console.warn('⚠️ Cliente desconectado:', reason);
    // Tenta reinicializar se for desconexão inesperada
    console.log('Tentando reconectar em 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
});

// --- Funções Auxiliares do Chatbot ---

async function safeGetContact(msg) {
    try {
        const contact = await msg.getContact();
        return {
            pushname: contact.pushname || contact.name || 'amigo',
            id: msg.from
        };
    } catch (err) {
        console.warn('⚠️ Falha ao obter contato:', err.message);
        return { pushname: 'amigo', id: msg.from };
    }
}

const delay = ms => new Promise(res => setTimeout(res, ms));
const clientesAvisadosForaDoHorario = new Set();
const userCurrentOption = new Map();

const foraDoHorario = () => {
    const agora = new Date();
    const horaBrasilia = (agora.getUTCHours() - 3 + 24) % 24;
    return (horaBrasilia < 5 || horaBrasilia >= 23);
};

// Limpeza diária de estados
setInterval(() => {
    clientesAvisadosForaDoHorario.clear();
    console.log('🧹 Limpeza diária de cache realizada.');
}, 24 * 60 * 60 * 1000);

async function sendMenu(from, contactName) {
    try {
        const firstName = contactName.split(' ')[0];
        const chat = await client.getChatById(from);
        
        await chat.sendStateTyping();
        await delay(1500);

        const menu = [
            `Olá, *${firstName}*! Seja bem-vindo à *Pamonha e Cia* 🌽`,
            'Sou seu assistente virtual!',
            '',
            'Por favor, escolha uma opção *(digite apenas o número)*:',
            '',
            '1️⃣ Fazer um pedido',
            '2️⃣ Encomendar milho',
            '3️⃣ Falar com um atendente'
        ].join('\n');

        await client.sendMessage(from, menu);
    } catch (err) {
        console.error('❌ Erro ao enviar menu:', err);
    }
}

// --- Lógica de Mensagens Recebidas ---

client.on('message', async msg => {
    try {
        // Ignorar grupos e status
        if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;
        
        // Aceitar apenas mensagens de texto
        if (msg.type !== 'chat') return;

        const from = msg.from;
        const body = msg.body ? msg.body.trim() : '';
        if (!body) return;

        // Verificar horário de atendimento
        if (foraDoHorario()) {
            if (!clientesAvisadosForaDoHorario.has(from)) {
                await client.sendMessage(from, '🕒 Não estamos atendendo no momento. Deixe sua mensagem e responderemos em breve!');
                clientesAvisadosForaDoHorario.add(from);
            }
            return;
        }

        const textLower = body.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        // Gatilhos de saudação
        const greetingsList = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'menu', 'inicio'];
        const isGreeting = greetingsList.some(g => textLower.includes(g));

        if (isGreeting && !hasGreetedToday(from)) {
            const contact = await safeGetContact(msg);
            userCurrentOption.delete(from);
            await sendMenu(from, contact.pushname);
            markGreetedNow(from);
            return;
        }

        // Fluxo de Opções
        if (body === '1') {
            userCurrentOption.set(from, '1');
            const chat = await client.getChatById(from);
            await chat.sendStateTyping();
            await delay(1000);
            
            await client.sendMessage(from, '🛵 Entregamos nossos produtos fresquinhos em Praia Grande, Santos, São Vicente e Mongaguá!\n\nJunto com o seu pedido, informe seu *endereço completo*.');
            await client.sendMessage(from, '📋 Aqui está o nosso cardápio!\nTaxa de entrega: R$ 5,00 (8h às 17h).');
            
            const mediaPath = path.join(__dirname, 'Cardápio Empresa.jpg');
            if (fs.existsSync(mediaPath)) {
                const media = MessageMedia.fromFilePath(mediaPath);
                await client.sendMessage(from, media, { caption: '📋 Nosso Cardápio' });
            }
            await client.sendMessage(from, 'Digite *4* para voltar ao menu inicial.');
            
        } else if (body === '2') {
            userCurrentOption.set(from, '2');
            await client.sendMessage(from, '🌽 *Encomenda de Milho*\n\nSe já é cliente, informe a quantidade de sacos.\n\nSe é seu primeiro pedido, informe:\n📍 Endereço completo\n💵 Valor: R$ 90,00 (Saco Grande)\n\nDigite *4* para voltar ao menu.');
            
        } else if (body === '3') {
            userCurrentOption.set(from, '3');
            await client.sendMessage(from, '👤 Entendido! Um atendente irá falar com você em instantes. Por favor, aguarde.\n\nDigite *4* para voltar ao menu.');
            
        } else if (body === '4') {
            const contact = await safeGetContact(msg);
            userCurrentOption.delete(from);
            await sendMenu(from, contact.pushname);
        }

    } catch (err) {
        console.error('❌ Erro no processamento:', err);
    }
});

// --- Servidor Web para Monitoramento ---
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Chatbot Status: Online'));
app.get('/qr', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) {
        res.send(`<html><body style="background:#111;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
            <h2>Escaneie o QR Code</h2>
            <img src="/qr.png" style="border:10px solid #fff;border-radius:10px;max-width:300px;"/>
            <p>Atualize a página se necessário.</p>
        </body></html>`);
    } else {
        res.send('Aguardando geração do QR Code... Recarregue em instantes.');
    }
});
app.get('/qr.png', (req, res) => {
    const imgPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(imgPath)) res.sendFile(imgPath);
    else res.status(404).send('Não disponível');
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Monitor rodando em http://localhost:${PORT}`));

// --- Inicialização ---
console.log('Iniciando WhatsApp Client...');
client.initialize().catch(err => console.error('Erro Fatal na Inicialização:', err));

// Shutdown
process.on('SIGINT', async () => {
    console.log('Desligando...');
    await client.destroy();
    process.exit(0);
});