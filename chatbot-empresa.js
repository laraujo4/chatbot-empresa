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
      //console.log('✅ greetings salvo');
    } catch (e) {
      console.error('Erro ao salvar greetings.json:', e);
    }
  }, 500);
}

// retorna a data atual no fuso de Brasilia (YYYY-MM-DD)
function hojeEmBrasil() {
  // supondo que o servidor esteja em UTC, aplica -3h para obter a data em GMT-3
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

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'mili-bot',
    dataPath: path.join(__dirname, 'session')
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
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// serviço de leitura do qr code
client.on('qr', async qr => {
  try {
    console.log('🟨 Novo QR recebido — gerando imagem em /qr ...');

    // tenta imprimir versão reduzida no terminal (útil localmente)
    try {
      qrcode.generate(qr, { small: true });
    } catch (err) {
      console.error('Erro ao gerar QR no terminal com qrcode-terminal:', err);
    }

    // debounce: se vários eventos vierem em sequência, só grava depois do intervalo
    if (qrWriteTimeout) clearTimeout(qrWriteTimeout);
    qrWriteTimeout = setTimeout(async () => {
      try {
        // Se o QR for igual ao último, não regrava (evita I/O desnecessário)
        if (lastQr && lastQr === qr) {
          console.log('QR idêntico ao anterior — pulando regravação.');
          return;
        }

        // opções: ajuste width/margin/errorCorrectionLevel conforme preferir
        const opts = {
          type: 'png',
          width: 800,
          margin: 2,
          errorCorrectionLevel: 'M'
        };

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

// ready + log único
client.on('ready', () => {
  console.log('✅ WhatsApp conectado com sucesso!');
});

// logs úteis de eventos de auth/disconnect
client.on('auth_failure', msg => {
  console.error('Falha de autenticação:', msg);
});
client.on('disconnected', reason => {
  console.warn('Cliente desconectado:', reason);
});

// inicializa o client
client.initialize();

const delay = ms => new Promise(res => setTimeout(res, ms));

// --- CONSTANTES / ESTADOS GLOBAIS ---
const clientesAvisadosForaDoHorario = new Set();
const userCurrentOption = new Map();

// --- LIMPA A LISTA À MEIA-NOITE ---
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

// função helper para enviar o menu
async function sendMenu(from, contact) {
  try {
    const name = (contact && contact.pushname) ? contact.pushname : 'amigo';
    const firstName = name.split(' ')[0];

    await delay(1000);
    const chat = await client.getChatById(from);
    if (chat && chat.sendStateTyping) {
      await chat.sendStateTyping();
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

    await client.sendMessage(from, menu);
  } catch (err) {
    console.error('Erro em sendMenu:', err);
  }
}

// Funil principal
client.on('message', async msg => {
  try {
    if (msg.type && msg.type !== 'chat') return;

    const from = msg.from;
    if (!from || !from.endsWith('@c.us')) return;

    const chat = await msg.getChat();

    // Fora do horário
    if (foraDoHorario()) {
      if (!clientesAvisadosForaDoHorario.has(from)) {
        await client.sendMessage(from, '🕒 Nosso horário de atendimento é das 7h às 19h. Deixe sua mensagem e responderemos em breve!');
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

    const greetings = [
      'menu', 'teste', 'boa', 'boa noite', 'boa tarde', 'bom dia',
      'oi', 'ola', 'oi bom dia', 'oi boa tarde', 'oi boa noite',
      'oi, bom dia', 'oi, boa tarde', 'oi, boa noite',
      'olá', 'olá bom dia', 'olá boa tarde', 'olá boa noite', 'ola'
    ];
    const isGreeting = greetings.some(g => text.includes(g.replace(/á/g, 'a')));

    if (isGreeting) {
      // se já foi saudado hoje, NÃO reenviamos o menu
      if (hasGreetedToday(from)) {
        console.log('Já enviamos saudação hoje para', from);
        // opcional: responder algo curto em vez de ignorar completamente
        // await client.sendMessage(from, 'Já nos falamos hoje — em que posso ajudar?');
        return;
      }

      const contact = await msg.getContact();
      userCurrentOption.delete(from);
      await sendMenu(from, contact);
      markGreetedNow(from); // registra que já enviamos a saudação hoje
      return;
    }

    if (userCurrentOption.has(from)) {
      if (rawTrim === '4') {
        const contact = await msg.getContact();
        userCurrentOption.delete(from);
        await sendMenu(from, contact);
        markGreetedNow(from); // opcional: contar como saudação do dia
        return;
      }
      return;
    }

    // --- Opções do menu ---
    if (rawTrim === '1') {
      userCurrentOption.set(from, '1');
      await delay(1000);
      await chat.sendStateTyping();
      await delay(1000);
      await client.sendMessage(from, '🛵 Entregamos nossos produtos fresquinhos pra você em Praia Grande, Santos, São Vicente e Mongaguá!\n\nPara outras cidades, consulte disponibilidade.');
      await delay(1000);
      await chat.sendStateTyping();
      await delay(1000);
      await client.sendMessage(from, '📋 Aqui está o nosso cardápio!\n\nJunto com o seu pedido, informe também o seu *endereço (rua, número e bairro)*.\n\n💳 Aceitamos *Pix*, *débito* e *dinheiro*!');
      await delay(1000);
      await chat.sendStateTyping();
      await delay(1000);
      await client.sendMessage(from, 'Nossas entregas são feitas de terça a domingo, das 8h às 17h! 😉');
      try {
        const mediaPath = './Cardápio Empresa.jpg';
        if (fs.existsSync(mediaPath)) {
          const media = MessageMedia.fromFilePath(mediaPath);
          await client.sendMessage(from, media, { caption: '📋 Cardápio' });
        } else {
          console.warn('Arquivo de mídia não encontrado:', mediaPath);
        }
      } catch (err) {
        console.error('Erro ao enviar mídia:', err);
      }

      await client.sendMessage(from, 'Se quiser voltar ao menu inicial, digite 4');
      return;
    }

    if (rawTrim === '2') {
      userCurrentOption.set(from, '2');
      await delay(1000);
      await chat.sendStateTyping();
      await delay(1000);
      await client.sendMessage(from, '🌽 Se você já é cliente, é só falar a quantidade de *sacos de milho* que você deseja encomendar.\n\nSe esse for o seu primeiro pedido, por favor, informe:\n📍 Endereço (rua, número, bairro e cidade)\n💵 *O valor do saco de milho é de R$ 90,00 (tamanho grande)*\n\n(Se quiser voltar ao menu inicial, digite 4)');
      return;
    }

    if (rawTrim === '3') {
      userCurrentOption.set(from, '3');
      await delay(1000);
      await chat.sendStateTyping();
      await delay(1000);
      await client.sendMessage(from, '👤 Beleza!\nUm *atendente* vai te chamar em instantes.\n\nEnquanto isso, fica à vontade para enviar dúvidas ou pedidos 😊\n\nSe quiser voltar ao menu inicial, digite 4');
      return;
    }

  } catch (err) {
    console.error('❌ Erro no processamento da mensagem:', err);
  }
});

// --- HORÁRIO DE FUNCIONAMENTO ---
const foraDoHorario = () => {
  const agora = new Date();
  const horaUTC = agora.getUTCHours();
  const horaBrasilia = (horaUTC - 3 + 24) % 24; // GMT-3
  return (horaBrasilia < 7 || horaBrasilia >= 20);
};

// --- Express health / status ---
const app = express();
const PORT = process.env.PORT || 8080;

// rota de health
app.get('/', (req, res) => res.send('OK'));

// rota que mostra a imagem (HTML simples)
app.get('/qr', (req, res) => {
  const imgPath = path.join(publicDir, 'qr.png');
  if (fs.existsSync(imgPath)) {
    const html = ''
      + '<html>'
      + '<body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff">'
      + '<div style="text-align:center">'
      + '<h3>Escaneie este QR code para conectar o WhatsApp</h3>'
      + '<img src="/qr.png" style="max-width:90vw;"/>'
      + '<p style="opacity:.7">Atualiza automaticamente quando um novo QR for emitido.</p>'
      + '</div>'
      + '</body>'
      + '</html>';
    return res.send(html);
  } else {
    return res.send('QR ainda não gerado — aguarde alguns segundos e recarregue a página.');
  }
});

// rota para servir o png diretamente
app.get('/qr.png', (req, res) => {
  const imgPath = path.join(publicDir, 'qr.png');
  if (fs.existsSync(imgPath)) {
    res.sendFile(imgPath);
  } else {
    res.status(404).send('QR não disponível');
  }
});

// iniciar servidor
app.listen(PORT, '0.0.0.0', () => console.log('HTTP server rodando na porta ' + PORT));

// Graceful shutdown
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