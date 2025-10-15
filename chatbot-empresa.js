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
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // fallback local
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
client.on('qr', qr => {
  console.log('🟨 Escaneie este QR code para conectar o WhatsApp:');

  // versão reduzida para terminais
  try {
    qrcode.generate(qr, { small: true });
  } catch (err) {
    console.error('Erro ao gerar QR no terminal com qrcode-terminal:', err);
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
  const proximaMeiaNoite = new Date();
  proximaMeiaNoite.setHours(24, 0, 0, 0);
  const tempoAteMeiaNoite = proximaMeiaNoite - agora;

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
      `Olá, ${firstName}! Seja bem-vindo à *Pamonha e Cia* 🌽`,
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
        await client.sendMessage(from, '🕒 Nosso horário de atendimento é das 7h às 20h. Deixe sua mensagem e responderemos em breve!');
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
      'menu', 'teste', 'boa', 'boa noite', 'boa tarde', 'bom dia', 'noite',
      'oi', 'ola', 'oi bom dia', 'oi boa tarde', 'oi boa noite',
      'olá', 'olá bom dia', 'olá boa tarde', 'olá boa noite'
    ];
    const isGreeting = greetings.some(g => text.includes(g.replace(/á/g, 'a')));

    if (isGreeting) {
      const contact = await msg.getContact();
      userCurrentOption.delete(from);
      await sendMenu(from, contact);
      return;
    }

    if (userCurrentOption.has(from)) {
      if (rawTrim === '4') {
        const contact = await msg.getContact();
        userCurrentOption.delete(from);
        await sendMenu(from, contact);
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
      await client.sendMessage(from, '📋 Aqui está o nosso cardápio!\n\nJunto com o seu pedido, informe também o seu *endereço (rua, número e bairro)*.\n\n💳 Aceitamos *Pix* e *débito*!');

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
      await client.sendMessage(from, '🌽 Se você já é cliente, é só falar a quantidade de *sacos de milho* que você deseja encomendar.\n\nSe esse for o seu primeiro pedido, por favor, informe:\n📍 Endereço (rua, número, bairro e cidade)\n💵 *O valor do saco de milho é de R$ 90 (tamanho grande)*\n\n(Se quiser voltar ao menu inicial, digite 4)');
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

// iniciar servidor
app.listen(PORT, '0.0.0.0', () => console.log(`HTTP server rodando na porta ${PORT}`));

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