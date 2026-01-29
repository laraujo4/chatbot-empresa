'use strict';

// leitor de qr code
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const express = require('express');
const { Client, LocalAuth, Buttons, List, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const path = require('path');

// ===================== Config / Paths =====================

// pasta de sessão (pode ser sobrescrita por variável de ambiente)
const sessionPath = process.env.SESSION_PATH || '/data/session';
if (!fs.existsSync(sessionPath)) {
  fs.mkdirSync(sessionPath, { recursive: true });
  console.log('Criada pasta de sessão em', sessionPath);
}

// ---- controle de saudações diárias (persistente) ----
const greetingsFile = path.join(sessionPath, 'greetings.json');
let greetings = {}; // { '<chatId>': 'YYYY-MM-DD', ... }
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

// retorna a data atual no fuso de Brasilia (YYYY-MM-DD)
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

// carregar na inicialização
loadGreetings();

// pasta pública para servir a imagem do QR
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  console.log('Criada pasta pública em', publicDir);
}

// variável para evitar geração excessiva (debounce)
let lastQr = null;
let qrWriteTimeout = null;

// ===================== WhatsApp Client =====================

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'mili-bot',
    // IMPORTANTE: usar sessionPath para persistir no volume (/data/session)
    dataPath: sessionPath
  }),
  puppeteer: {
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      puppeteer.executablePath() ||
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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

// ---------- wrappers seguros melhorados para obter contato -------------
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
      const chatName =
        chat.formattedTitle || chat.name || (chat.contact && (chat.contact.pushname || chat.contact.name));
      if (chatName && typeof chatName === 'string') {
        return { pushname: chatName.trim(), id: { _serialized: from } };
      }
    }
  } catch (err) {
    console.warn('safeGetContact: falha ao tentar via chat:', err);
  }

  return { pushname: 'amigo', id: { _serialized: from } };
}

/* serviço de leitura do qr code */
client.on('qr', async (qr) => {
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

client.on('auth_failure', (msg) => {
  console.error('Falha de autenticação:', msg);
});

client.on('disconnected', (reason) => {
  console.warn('Cliente desconectado:', reason);
});

client.initialize();

// ===================== Fluxo / Estado =====================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));
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
    const name = contact && contact.pushname ? contact.pushname : 'amigo';
    const firstName = name.split(' ')[0];

    await delay(1000);

    let chat = null;
    try {
      chat = await client.getChatById(from);
    } catch (e) {
      console.warn(
        'sendMenu: não foi possível obter chat via client.getChatById():',
        e && e.message ? e.message : e
      );
    }

    if (chat && chat.sendStateTyping) {
      try {
        await chat.sendStateTyping();
      } catch (e) {
        /* ignora */
      }
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

    // IMPORTANTE: sendSeen:false evita crash comum do whatsapp-web.js
    await client.sendMessage(from, menu, { sendSeen: false });
  } catch (err) {
    console.error('Erro em sendMenu:', err);
  }
}

// CORREÇÃO: horário consistente (5h às 23h)
const foraDoHorario = () => {
  const agora = new Date();
  const horaUTC = agora.getUTCHours();
  const horaBrasilia = (horaUTC - 3 + 24) % 24;
  return horaBrasilia < 5 || horaBrasilia >= 23;
};

// Funil principal
client.on('message', async (msg) => {
  try {
    // ===================== DEBUG LOG (principal) =====================
    const from = msg?.from;
    const body = (msg?.body ?? '').toString();
    const type = msg?.type;
    const fromMe = !!msg?.fromMe;
    const isStatus = !!msg?.isStatus;

    console.log(
      [
        '📩 [IN MSG]',
        `from=${from}`,
        `type=${type}`,
        `fromMe=${fromMe}`,
        `isStatus=${isStatus}`,
        `body="${body.replace(/\n/g, '\\n').slice(0, 300)}"`,
        `horaBrasilia=${(() => {
          const h = (new Date().getUTCHours() - 3 + 24) % 24;
          return h;
        })()}`,
        `foraDoHorario=${foraDoHorario()}`,
        `hasGreetedToday=${from ? hasGreetedToday(from) : 'n/a'}`,
        `userCurrentOption=${from ? (userCurrentOption.has(from) ? userCurrentOption.get(from) : 'none') : 'n/a'}`
      ].join(' | ')
    );

    // Ignora mensagens próprias e status (evita loops e ruído)
    if (fromMe) {
      console.log('⏭️ Ignorando: msg.fromMe=true');
      return;
    }
    if (isStatus) {
      console.log('⏭️ Ignorando: msg.isStatus=true');
      return;
    }

    // aceita 'chat' e 'text'
    if (type && !['chat', 'text'].includes(type)) {
      console.log('⏭️ Ignorando: tipo não suportado:', type);
      return;
    }

    if (!from) {
      console.log('⏭️ Ignorando: msg.from vazio');
      return;
    }
    if (from.endsWith('@g.us') || from.endsWith('@broadcast')) {
      console.log('⏭️ Ignorando: grupo/broadcast:', from);
      return;
    }

    let chat = null;
    try {
      chat = await msg.getChat();
    } catch (e) {
      console.warn('⚠️ Falha ao obter chat via msg.getChat():', e?.message || e);
    }

    // Fora do horário
    if (foraDoHorario()) {
      console.log('🕒 Fora do horário');
      if (!clientesAvisadosForaDoHorario.has(from)) {
        await client.sendMessage(
          from,
          '🕒 Não estamos atendendo no momento. Deixe sua mensagem e responderemos em breve!',
          { sendSeen: false }
        );
        clientesAvisadosForaDoHorario.add(from);
      } else {
        console.log('🕒 Já avisado hoje (fora do horário), não reenviando.');
      }
      return;
    }

    const raw = body;
    const rawTrim = raw.trim();
    if (!rawTrim) {
      console.log('⏭️ Ignorando: mensagem vazia');
      return;
    }

    const text = raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .trim();

    const greetingsList = [
      'menu', 'teste', 'boa', 'boa noite', 'boa tarde', 'bom dia', 'boa dia',
      'oi', 'oii', 'ola', 'oi bom dia', 'oi boa tarde', 'boa tardr', 'oi boa noite',
      'oi, bom dia', 'oi, boa tarde', 'oi, boa noite', 'olá', 'olá bom dia',
      'olá boa tarde', 'olá boa noite', 'ola', 'olaa'
    ];

    const isGreeting = greetingsList.some((g) => text.includes(g.replace(/á/g, 'a')));
    console.log('🔎 isGreeting=', isGreeting, '| normalizedText=', text);

    if (isGreeting) {
      if (hasGreetedToday(from)) {
        console.log('👋 Já enviamos saudação hoje para', from, '(não reenviando menu)');
        return;
      }
      const contact = await safeGetContact(msg);
      userCurrentOption.delete(from);
      await sendMenu(from, contact);
      markGreetedNow(from);
      return;
    }

    if (userCurrentOption.has(from)) {
      console.log('🧭 Usuário está em submenu:', userCurrentOption.get(from));
      if (rawTrim === '4') {
        console.log('↩️ Recebeu 4: retornando ao menu');
        const contact = await safeGetContact(msg);
        userCurrentOption.delete(from);
        await sendMenu(from, contact);
        markGreetedNow(from);
        return;
      }
      console.log('🤫 Regra: silêncio no submenu (aguardando detalhes do usuário).');
      return;
    }

    // --- Opções do menu ---
    if (rawTrim === '1') {
      console.log('✅ Opção 1 selecionada');
      userCurrentOption.set(from, '1');

      await delay(1000);
      try { await chat?.sendStateTyping?.(); } catch (e) { /* ignora */ }
      await delay(1000);

      await client.sendMessage(
        from,
        '🛵 Entregamos nossos produtos fresquinhos em Praia Grande, Santos, São Vicente e Mongaguá! Para outras cidades, consulte disponibilidade.\n\nJunto com o seu pedido, informe também o seu *endereço (rua, número e bairro)*.',
        { sendSeen: false }
      );

      await delay(1000);
      try { await chat?.sendStateTyping?.(); } catch (e) { /* ignora */ }
      await delay(1000);

      await client.sendMessage(
        from,
        '📋 Aqui está o nosso cardápio!\n\nA taxa de entrega é de R$ 5,00, e elas são feitas das 8h às 17h! 😉',
        { sendSeen: false }
      );

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
      console.log('✅ Opção 2 selecionada');
      userCurrentOption.set(from, '2');

      await delay(1000);
      try { await chat?.sendStateTyping?.(); } catch (e) { /* ignora */ }
      await delay(1000);

      await client.sendMessage(
        from,
        '🌽 Se você já é cliente, é só falar a quantidade de *sacos de milho* que você deseja encomendar.\n\nSe esse for o seu primeiro pedido, por favor, informe:\n📍 Endereço (rua, número, bairro e cidade)\n💵 *O valor do saco de milho é de R$ 90,00 (tamanho grande)*\n\n(Se quiser voltar ao menu inicial, digite 4)',
        { sendSeen: false }
      );
      return;
    }

    if (rawTrim === '3') {
      console.log('✅ Opção 3 selecionada');
      userCurrentOption.set(from, '3');

      await delay(1000);
      try { await chat?.sendStateTyping?.(); } catch (e) { /* ignora */ }
      await delay(1000);

      await client.sendMessage(
        from,
        '👤 Beleza!\nUm *atendente* vai te chamar em instantes.\n\nEnquanto isso, fica à vontade para enviar dúvidas ou pedidos 😊\n\nSe quiser voltar ao menu inicial, digite 4',
        { sendSeen: false }
      );
      return;
    }

    console.log('🤔 Mensagem fora das opções/gatilhos atuais; nenhuma ação tomada.');
  } catch (err) {
    console.error('❌ Erro no processamento da mensagem:', err);
  }
});

// ===================== Express health / status =====================

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('OK'));

// FIX: HTML do /qr em template literal (evita erro de sintaxe e deixa auto-refresh funcionando)
app.get('/qr', (req, res) => {
  const imgPath = path.join(publicDir, 'qr.png');
  if (fs.existsSync(imgPath)) {
    const html = `<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="refresh" content="10" />
  <title>QR Code - WhatsApp</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 24px; background: #fafafa; }
    img { width: min(420px, 90vw); height: auto; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.12); }
    .hint { margin-top: 12px; color: #444; }
  </style>
</head>
<body>
  <h1>Escaneie este QR code para conectar o WhatsApp</h1>
  <p class="hint">Atualiza automaticamente a cada 10s.</p>
  <img src="/qr.png?v=${Date.now()}" alt="QR Code WhatsApp" />
</body>
</html>`;
    return res.send(html);
  }
  return res.send('QR ainda não gerado — aguarde alguns segundos e recarregue a página.');
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

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
