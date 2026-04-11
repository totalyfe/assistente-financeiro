require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const cors = require('cors');
const fs = require('fs');
const FormData = require('form-data');
const { nanoid } = require('nanoid');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const { 
  OPENAI_API_KEY, ZAPI_TOKEN, ZAPI_INSTANCE, MONGODB_URI, ZAPI_CLIENT_TOKEN, API_SECRET_TOKEN 
} = process.env;

if (!API_SECRET_TOKEN) console.warn("⚠️ API_SECRET_TOKEN não definido. Rotas da API estarão desprotegidas.");

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB conectado 🔥"))
  .catch(err => console.log("Erro MongoDB:", err));

// --- CONFIGURAÇÃO DE EMOJIS CENTRALIZADA ---
const EMOJIS_CATEGORIAS = { 
  "Mercado": "🛒", "Transporte": "🚗", "Lazer": "🍺", "Saúde": "💊", "Aluguel": "🏠",
  "Educação": "📚", "Casa": "🏠", "Salário": "💰", "Alimentação": "🧃", "Recebimento": "💰", 
  "Pix": "💸", "Internet": "🛜", "Pet": "🐶", "Padaria": "🥖", "Assinaturas": "📺", "Outros": "📦" 
};

// --- TEXTOS DE AJUDA CENTRALIZADOS ---
const HELP_TEXT = `━━━━━━━━━━━━━━━

💸 *Lançamentos rápidos*
- Pode enviar *texto ou áudio*
- Eu entendo automaticamente 😉

💰 Palavras como:
"recebi", "ganhei", "caiu" → *RECEITA*

💸 Palavras como:
"gastei", "comprei", "paguei" → *DESPESA*

📅 Sem data?
Uso *hoje automaticamente*

📌 *Exemplos:*
- Recebi 1200 de salário
- Gastei 50 no mercado
- Comprei um lanche por 25 na padaria

━━━━━━━━━━━━━━━

🔍 *Buscar gastos*
- "gastos"
- "gastos mercado"
- "o que gastei essa semana"

❌ *Excluir lançamento*
- "excluir última"
- "excluir transação ABC12"

━━━━━━━━━━━━━━━

🗂 *Organização automática*
- Eu classifico tudo sozinho por categoria ✅

━━━━━━━━━━━━━━━

🏦 *Contas (bancos)*
- "nubank 1000"
- "adicionar 200 no inter"
- "mude meu saldo do nubank pra 2000"
- "qual meu saldo?"

━━━━━━━━━━━━━━━

💸 *Transferências*
- "transferir 200 do nubank pro inter"

━━━━━━━━━━━━━━━

🔁 *Contas fixas (recorrentes)*
- "todo mês 1000 aluguel dia 5"
- "Academia 100 todo dia 10"

━━━━━━━━━━━━━━━

🎯 *Meta mensal de gastos*
- "meta 2000"

━━━━━━━━━━━━━━━

🔔 *Alertas*
- Criar/atualizar limites por categoria: "limite mercado 500"
- Consultar limites: "meus limites"

━━━━━━━━━━━━━━━

📈 *Relatórios*
- Gráficos e relatórios no painel

━━━━━━━━━━━━━━━

🧠 *Análise inteligente*
- "analisar"

━━━━━━━━━━━━━━━

💬 *Dica importante:*
Fale comigo como falaria com uma pessoa 😄

Ex:
"paguei 30 no lanche ontem no débito"

🚀 Bora começar? Me manda seu primeiro lançamento!

━━━━━━━━━━━━━━━`;

const WELCOME_TEXT = `👴 *Fala, %nome%! Eu sou o Zeca do Caixa!* 💰

Vou te ensinar rapidinho como organizar sua vida financeira aqui no WhatsApp 👇

${HELP_TEXT}`;

// --- MODELOS ---
const Wallet = mongoose.model("Wallet", new mongoose.Schema({
  phone: String,
  nome: { type: String, required: true },
  tipo: { type: String, enum: ["Corrente", "Crédito"], default: "Corrente" },
  saldo: { type: Number, default: 0 },
  limite: { type: Number, default: 0 }
}));

const Finance = mongoose.model("Finance", new mongoose.Schema({
  phone: String, 
  idCurto: { type: String, unique: true },
  tipo: String, 
  categoria: String, 
  valor: Number, 
  observacao: String, 
  pago: { type: Boolean, default: true },
  recorrente: { type: Boolean, default: false },
  vencimento: { type: Date, default: Date.now },
  data: { type: Date, default: Date.now }
}));

const User = mongoose.model("User", new mongoose.Schema({
  phone: String, name: String, metaMensal: { type: Number, default: 0 }, createdAt: { type: Date, default: Date.now }
}));

const Recorrencia = mongoose.model("Recorrencia", new mongoose.Schema({
  phone: String, 
  tipo: { type: String, default: "Gasto" }, 
  categoria: String, 
  valor: Number, 
  diaVencimento: Number, 
  descricao: String, 
  carteira: { type: String, default: "DINHEIRO" },
  ativa: { type: Boolean, default: true }
}));

const CategoryLimit = mongoose.model("CategoryLimit", new mongoose.Schema({
  phone: String,
  categoria: String,
  limiteMensal: Number,
  mesReferencia: { type: String, default: () => new Date().toISOString().slice(0,7) }
}));

const Reminder = mongoose.model("Reminder", new mongoose.Schema({
  phone: String,
  descricao: String,
  valor: Number,
  tipo: { type: String, enum: ["pagar", "receber"] },
  dataVencimento: Date,
  diasAntecedencia: { type: Number, default: 2 },
  enviado: { type: Boolean, default: false },
  ativo: { type: Boolean, default: true }
}));

// --- FUNÇÕES DE ENVIO ---
async function sendZap(phone, message) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
    { phone, message }, 
    { headers: { "Content-Type": "application/json", "client-token": ZAPI_CLIENT_TOKEN } });
  } catch (e) { console.log(`Erro envio para ${phone}:`, e.message); }
}

async function sendZapMenu(phone, message) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-option-list`, {
      phone,
      message,
      optionList: {
        title: "Ações rápidas",
        buttonLabel: "Abrir menu",
        options: [
          { id: "resumo", description: "Ver o saldo e relatório", title: "📊 Ver resumo" },
          { id: "painel", description: "Abrir gráficos completos", title: "🌐 Abrir painel" },
          { id: "apagar", description: "Excluir última transação", title: "❌ Excluir última" }
        ]
      }
    }, { headers: { "Content-Type": "application/json", "client-token": ZAPI_CLIENT_TOKEN } });
  } catch (e) { 
    console.log("Erro menu:", e.message);
    await sendZap(phone, message + "\n\nDigite: resumo | painel | excluir");
  }
}

async function transcreverAudio(audioUrl, phone) {
  let fileName = null;
  try {
    const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    fileName = `./${phone}_${Date.now()}.ogg`;
    fs.writeFileSync(fileName, Buffer.from(audioResponse.data));
    const formData = new FormData();
    formData.append('file', fs.createReadStream(fileName));
    formData.append('model', 'whisper-1');
    const transcription = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: { ...formData.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` }
    });
    return transcription.data.text;
  } catch (err) {
    console.log("Erro áudio:", err.message);
    throw new Error("Não foi possível transcrever o áudio.");
  } finally {
    if (fileName && fs.existsSync(fileName)) fs.unlinkSync(fileName);
  }
}

function detectarCategoria(msg) {
  const m = msg.toLowerCase();
  if (m.includes("mercado")) return "Mercado";
  if (m.match(/(uber|99|gasolina|combustivel|posto|carro)/i)) return "Transporte";
  if (m.match(/(pizza|lanche|ifood|restaurante|comer|janta)/i)) return "Alimentação";
  if (m.match(/(netflix|spotify|prime|hbo|disney)/i)) return "Assinaturas";
  if (m.match(/(farmacia|remedio|medico|hospital|saude)/i)) return "Saúde";
  if (m.includes("aluguel")) return "Aluguel";
  if (m.match(/(padaria|pao|cafe)/i)) return "Padaria";
  if (m.match(/(internet|wifi|wi-fi|vivo|claro|tim)/i)) return "Internet";
  if (m.match(/(pet|dog|gato|racao|veterinario)/i)) return "Pet";
  if (m.match(/(lazer|cerveja|breja|role|cinema)/i)) return "Lazer";
  return "Outros";
}

function interpretarRapido(message) {
  const msg = message.toLowerCase();

  // DELETAR CONTA
  const deletarContaMatch = msg.match(/deletar\s+conta\s+(.+)/i);
  if (deletarContaMatch) {
    return { acao: "deletar_conta", nome: deletarContaMatch[1].trim().toUpperCase() };
  }

  // GASTO
  const gastoMatch = msg.match(/(gastei|paguei|comprei)\s+(\d+(?:[.,]\d{2})?)\s+(?:em\s+|no\s+|na\s+)?([a-zà-ú\s]+?)(?:\s+(?:no|na|pelo)\s+([a-z0-9à-ú\s]+))?$/i);
  if (gastoMatch) {
    let categoriaTexto = gastoMatch[3] ? gastoMatch[3].trim() : "Outros";
    let carteiraDetectada = gastoMatch[4] ? gastoMatch[4].toUpperCase().trim() : null;
    const bancos = ["nubank", "inter", "itau", "bradesco", "santander", "caixa", "credito", "cartao"];
    if (!carteiraDetectada && bancos.some(b => categoriaTexto.toLowerCase().includes(b))) {
      carteiraDetectada = categoriaTexto.toUpperCase();
      categoriaTexto = "Outros";
    }
    return {
      acao: "salvar",
      tipo: "Gasto",
      valor: parseFloat(gastoMatch[2].replace(',', '.')),
      categoria: detectarCategoria(categoriaTexto),
      carteira: carteiraDetectada,
      observacao: message,
      pago: true,
      recorrente: false
    };
  }

  // RECEITA
  const receitaMatch = msg.match(/(ganhei|recebi|caiu|depositaram)\s+(\d+(?:[.,]\d{2})?)(?:\s+(?:no|na|pelo)\s+([a-z0-9à-ú\s]+))?/i);
  if (receitaMatch) {
    return {
      acao: "salvar",
      tipo: "Recebimento",
      valor: parseFloat(receitaMatch[2].replace(',', '.')),
      categoria: "Recebimento",
      carteira: receitaMatch[3] ? receitaMatch[3].toUpperCase() : null,
      observacao: message,
      pago: true,
      recorrente: false
    };
  }

  // COMANDOS GERAIS
  if (msg.includes("painel")) return { acao: "painel" };
  if (msg.match(/(funções|funcoes|ajuda|help|menu|o que você faz)/i)) return { acao: "ajuda" };
  const metaMatch = msg.match(/meta\s+(\d+(?:[.,]\d{2})?)/i);
  if (metaMatch) return { acao: "set_meta", valor: Number(metaMatch[1].replace(',', '.')) };
  if (msg.includes("gastos") || msg.includes("compras")) return { acao: "buscar", termo: "TUDO" };
  if (msg.match(/(resumo|relatorio|relatório)/i)) return { acao: "resumo" };
  if (msg.includes("saldo")) return { acao: "ver_saldos" };
  const limiteMatch = msg.match(/limite\s+([a-zà-ú]+)\s+(\d+(?:[.,]\d{2})?)/i);
  if (limiteMatch) return { acao: "set_limite", categoria: limiteMatch[1], valor: parseFloat(limiteMatch[2].replace(',', '.')) };
  if (msg.includes("meus limites")) return { acao: "meus_limites" };
  const lembreteMatch = msg.match(/(lembrar|lembrete)\s+(pagar|receber)\s+(.+)\s+dia\s+(\d{1,2})\/(\d{1,2})\s+valor\s+(\d+(?:[.,]\d{2})?)/i);
  if (lembreteMatch) {
    return {
      acao: "criar_lembrete",
      tipo: lembreteMatch[2],
      descricao: lembreteMatch[3],
      dia: parseInt(lembreteMatch[4]),
      mes: parseInt(lembreteMatch[5]) - 1,
      valor: parseFloat(lembreteMatch[6].replace(',', '.'))
    };
  }
  if (msg.match(/(excluir|apagar|deletar)/i)) {
    if (msg.match(/(ultima|última)/i)) return { acao: "apagar" };
    const idMatch = msg.match(/([A-Z0-9]{6})/i);
    return { acao: "apagar", idCurto: idMatch ? idMatch[1].toUpperCase() : null };
  }
  return null;
}

async function verificarLimiteCategoria(phone, categoria, valorGasto) {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  const gastosMes = await Finance.aggregate([
    { $match: { phone, categoria, tipo: "Gasto", data: { $gte: inicioMes } } },
    { $group: { _id: null, total: { $sum: "$valor" } } }
  ]);
  const totalAtual = gastosMes[0]?.total || 0;
  const novoTotal = totalAtual + valorGasto;
  const limiteDoc = await CategoryLimit.findOne({ phone, categoria, mesReferencia: new Date().toISOString().slice(0,7) });
  if (limiteDoc && limiteDoc.limiteMensal > 0) {
    const percentual = (novoTotal / limiteDoc.limiteMensal) * 100;
    if (novoTotal > limiteDoc.limiteMensal) {
      await sendZap(phone, `⚠️ *ALERTA!* Você excedeu o limite de R$ ${limiteDoc.limiteMensal.toFixed(2)} para a categoria *${categoria}*. Total atual: R$ ${novoTotal.toFixed(2)}`);
    } else if (percentual >= 95) {
      await sendZap(phone, `🔔 *ATENÇÃO!* Você já usou ${percentual.toFixed(0)}% do limite de R$ ${limiteDoc.limiteMensal.toFixed(2)} para a categoria *${categoria}*.`);
    } else if (percentual >= 80) {
      await sendZap(phone, `⚠️ *Cuidado!* Você atingiu ${percentual.toFixed(0)}% do limite da categoria *${categoria}*.`);
    }
  }
}

// --- WEBHOOK PRINCIPAL ---
app.post("/webhook", async (req, res) => {
  const { phone, text, listResponseMessage, audio, fromMe } = req.body;
  res.sendStatus(200);
  if (fromMe === true) return;

  let message = text?.message || listResponseMessage?.title;

  if (audio && audio.audioUrl) {
    try {
      message = await transcreverAudio(audio.audioUrl, phone);
      console.log(`Zeca ouviu: "${message}"`);
    } catch (err) {
      await sendZap(phone, "Ih, meu filho... não entendi seu áudio.");
      return;
    }
  }

  if (!message || !phone) return;

  try {
    let user = await User.findOne({ phone });
    if (!user) {
      const nameResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "Extraia o nome. Se não houver, responda 'PEDIR'." }, { role: "user", content: message }]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
      const extractedName = nameResponse.data.choices[0].message.content.trim();
      if (extractedName === "PEDIR") {
        await sendZap(phone, "👋 Olá! Qual é o seu nome para começarmos?");
        return;
      } else {
        await User.create({ phone, name: extractedName });
        await sendZapMenu(phone, WELCOME_TEXT.replace("%nome%", extractedName));
        return;
      }
    }

    let data = interpretarRapido(message);
    if (!data) {
      const response = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Você é um assistente financeiro. Responda APENAS com JSON. Possíveis ações: salvar, resumo, apagar, set_meta, set_recorrente, set_wallet, ver_saldos, analisar, transferir, buscar, set_limite, meus_limites, criar_lembrete, ajuda. Para 'salvar', inclua tipo, valor, categoria, carteira, observacao, pago, recorrente, vencimento. Para 'buscar', termo pode ser 'TUDO' ou uma categoria.` },
          { role: "user", content: message }
        ],
        temperature: 0
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
      let aiReply = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
      try {
        data = JSON.parse(aiReply);
      } catch (e) {
        console.log("Erro parse IA:", aiReply);
        data = { acao: "conversa", resposta: "Não entendi direito... pode reformular?" };
      }
    }

    const nomesOficiais = { 
      "ITAU": "Itaú", "NUBANK": "Nubank", "NUBANK CREDITO": "Nubank Crédito",
      "INTER CREDITO": "Inter Crédito", "SANTANDER": "Santander", "BRADESCO": "Bradesco",
      "ITAU CREDITO": "Itaú Crédito", "BRADESCO CREDITO": "Bradesco Crédito",
      "SANTANDER CREDITO": "Santander Crédito", "INTER": "Inter", "PIX": "Dinheiro"
    };

    // --- AÇÕES ---
    if (data.acao === "set_meta") {
      user.metaMensal = data.valor;
      await user.save();
      await sendZap(phone, `🎯 Meta de gastos definida: *R$ ${data.valor.toFixed(2)}*.`);
    }
    else if (data.acao === "deletar_conta") {
      const nomeConta = data.nome;
      const conta = await Wallet.findOne({ phone, nome: { $regex: new RegExp(`^${nomeConta}$`, 'i') } });
      if (!conta) {
        await sendZap(phone, `❌ Conta "${nomeConta}" não encontrada.`);
      } else {
        await Wallet.deleteOne({ phone, nome: conta.nome });
        await sendZap(phone, `🗑️ Conta *${conta.nome}* removida com sucesso.`);
      }
    }
    else if (data.acao === "apagar") {
      let excluido;
      if (data.idCurto) {
        excluido = await Finance.findOneAndDelete({ phone, idCurto: data.idCurto });
      } else {
        excluido = await Finance.findOneAndDelete({ phone }, { sort: { data: -1 } });
      }
      if (excluido) {
        if (excluido.pago) {
          const carteiraNome = (excluido.observacao.match(/\[(.*?)\]/) || [])[1] || "DINHEIRO";
          const wallet = await Wallet.findOne({ phone, nome: carteiraNome });
          const ehCredito = wallet?.tipo === "Crédito";
          let multiplicador = excluido.tipo === "Gasto" ? 1 : -1;
          if (ehCredito && excluido.tipo === "Gasto") multiplicador = 1;
          if (ehCredito && excluido.tipo === "Recebimento") multiplicador = -1;
          await Wallet.updateOne({ phone, nome: carteiraNome }, { $inc: { saldo: excluido.valor * multiplicador } });
        }
        await sendZap(phone, `🗑️ Transação *${excluido.idCurto}* removida. Saldo ajustado.`);
      } else { 
        await sendZap(phone, "❌ Não encontrei essa transação.");
      }
    }
    else if (data.acao === "ajuda") {
      await sendZapMenu(phone, HELP_TEXT);
    }
    else if (data.acao === "set_recorrente") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      const nomeEntrada = data.carteira ? data.carteira.toUpperCase().trim() : "DINHEIRO";
      let carteiraFinal = nomesOficiais[nomeEntrada] || nomeEntrada;
      if (!nomesOficiais[nomeEntrada]) carteiraFinal = "Dinheiro";
      await Recorrencia.create({ phone, tipo: data.tipo || "Gasto", valor: valorLimpo, categoria: data.categoria, diaVencimento: data.dia, descricao: data.observacao, carteira: carteiraFinal });
      await sendZap(phone, `📌 *Agendado!* Todo dia ${data.dia} no *${carteiraFinal}*.`);
    }
    else if (data.acao === "set_wallet") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      let nomeEntrada = data.nome.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      let nomeFinal = nomesOficiais[nomeEntrada] || nomeEntrada;
      if (!nomesOficiais[nomeEntrada]) {
        await sendZap(phone, `⚠️ "${data.nome}" não é um banco reconhecido. Use nomes como Nubank, Itaú, etc. Conta não criada.`);
        return;
      }
      const count = await Wallet.countDocuments({ phone });
      if (count >= 3 && !(await Wallet.findOne({ phone, nome: nomeFinal }))) {
        await sendZap(phone, "⚠️ Limite de 3 contas bancárias atingido. Remova uma antes de adicionar outra.");
      } else {
        await Wallet.findOneAndUpdate({ phone, nome: nomeFinal }, { saldo: valorLimpo }, { upsert: true, new: true });
        await sendZap(phone, `🏦 Conta *${nomeFinal}* configurada com R$ ${valorLimpo.toFixed(2)}.`);
      }
    }
    else if (data.acao === "ver_saldos") {
      const carteiras = await Wallet.find({ phone, saldo: { $ne: 0 } });
      if (carteiras.length === 0) {
        await sendZap(phone, "Nenhuma conta ativa com saldo.");
      } else {
        let txtSaldos = carteiras.map(w => `🔹 *${w.nome}:* R$ ${w.saldo.toFixed(2)}`).join('\n');
        let total = carteiras.reduce((acc, curr) => acc + curr.saldo, 0);
        await sendZap(phone, `💰 *SALDOS:*\n\n${txtSaldos}\n\n💵 *TOTAL: R$ ${total.toFixed(2)}*`);
      }
    }
    else if (data.acao === "transferir") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      const limpar = (nome) => nome.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      const nomeOrigem = nomesOficiais[limpar(data.origem)] || limpar(data.origem);
      const nomeDestino = nomesOficiais[limpar(data.destino)] || limpar(data.destino);
      await Wallet.findOneAndUpdate({ phone, nome: nomeOrigem }, { $inc: { saldo: -valorLimpo } });
      await Wallet.findOneAndUpdate({ phone, nome: nomeDestino }, { $inc: { saldo: valorLimpo }, upsert: true });
      await Finance.create({ phone, idCurto: nanoid(6), tipo: "Transferência", categoria: "Transferência", valor: valorLimpo, observacao: `Pix: ${nomeOrigem} ➔ ${nomeDestino}` });
      await sendZap(phone, `💸 *Transferência concluída!*\n\nSaída: *${nomeOrigem}*\nEntrada: *${nomeDestino}*\nValor: R$ ${valorLimpo.toFixed(2)}`);
    }
    else if (data.acao === "buscar") {
      const termo = data.termo;
      let filtro = { phone, tipo: "Gasto" };
      if (termo !== "TUDO") {
        filtro.$or = [
          { categoria: { $regex: termo, $options: "i" } },
          { observacao: { $regex: termo, $options: "i" } }
        ];
      }
      const resultados = await Finance.find(filtro).sort({ data: -1 });
      if (resultados.length === 0) {
        await sendZap(phone, `🧐 Não achei nada sobre *"${termo}"*.`);
      } else {
        let total = 0;
        let lista = resultados.map(r => {
          total += r.valor;
          const dataF = new Date(r.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
          const emoji = EMOJIS_CATEGORIAS[r.categoria] || "📅";
          return `${emoji} ${dataF} - R$ ${r.valor.toFixed(2)} (${r.categoria}${r.observacao ? ': ' + r.observacao : ''})`;
        }).join('\n');
        await sendZap(phone, `🔍 *Busca: ${termo}*\n\n${lista}\n\n💰 *Total: R$ ${total.toFixed(2)}*`);
      }
    }
    else if (data.acao === "analisar") {
      const umaSemanaAtras = new Date(); umaSemanaAtras.setDate(umaSemanaAtras.getDate() - 7);
      const gastos = await Finance.find({ phone, tipo: "Gasto", data: { $gte: umaSemanaAtras } });
      if (gastos.length === 0) {
        await sendZap(phone, "Sem gastos na semana.");
      } else {
        const resumoParaIA = gastos.map(g => `${g.categoria}: R$ ${g.valor}`).join(", ");
        const analise = await axios.post("https://api.openai.com/v1/chat/completions", {
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: "Vovô Zeca ranzinza. Dê um conselho curto." }, { role: "user", content: `Gastos: ${resumoParaIA}` }]
        }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
        await sendZap(phone, `🧐 *ANÁLISE:* ${analise.data.choices[0].message.content}`);
      }
    }
    else if (data.acao === "painel") {
      await sendZap(phone, `🌐 Acesse seu painel completo:\n\nhttps://zecadocaixa.lovable.app/?phone=${phone}`);
    }
    else if (data.acao === "set_limite") {
      const categoria = data.categoria.charAt(0).toUpperCase() + data.categoria.slice(1).toLowerCase();
      const limite = data.valor;
      await CategoryLimit.findOneAndUpdate(
        { phone, categoria, mesReferencia: new Date().toISOString().slice(0,7) },
        { limiteMensal: limite },
        { upsert: true }
      );
      await sendZap(phone, `🔔 Limite para *${categoria}* definido como R$ ${limite.toFixed(2)} para este mês.`);
    }
    else if (data.acao === "meus_limites") {
      const limites = await CategoryLimit.find({ phone, mesReferencia: new Date().toISOString().slice(0,7) });
      if (limites.length === 0) {
        await sendZap(phone, "Você ainda não definiu limites para nenhuma categoria.");
      } else {
        let txt = "📊 *Seus limites mensais:*\n";
        for (const l of limites) {
          txt += `\n🔹 ${l.categoria}: R$ ${l.limiteMensal.toFixed(2)}`;
        }
        await sendZap(phone, txt);
      }
    }
    else if (data.acao === "criar_lembrete") {
      const dataVenc = new Date(new Date().getFullYear(), data.mes, data.dia);
      if (dataVenc < new Date()) dataVenc.setFullYear(dataVenc.getFullYear() + 1);
      await Reminder.create({
        phone, descricao: data.descricao, valor: data.valor, tipo: data.tipo,
        dataVencimento: dataVenc, diasAntecedencia: 2, enviado: false
      });
      await sendZap(phone, `🔔 Lembrete criado: ${data.tipo === "pagar" ? "🔴 Pagar" : "🟢 Receber"} *${data.descricao}* no valor de R$ ${data.valor.toFixed(2)} até ${dataVenc.toLocaleDateString('pt-BR')}.`);
    }
    else if (data.acao === "salvar") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      let carteiraNormalizada = data.carteira ? data.carteira.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim() : "";
      const ehCredito = carteiraNormalizada.includes("CREDITO");
      let nomeEntrada = data.carteira ? data.carteira.toUpperCase().trim() : "DINHEIRO";
      
      // VALIDAÇÃO: só cria carteira se for banco conhecido
      let carteiraNome;
      if (carteiraNormalizada && nomesOficiais[carteiraNormalizada]) {
        carteiraNome = nomesOficiais[carteiraNormalizada];
      } else if (carteiraNormalizada && nomesOficiais[carteiraNormalizada.replace("CREDITO", "").trim()]) {
        let base = carteiraNormalizada.replace("CREDITO", "").trim();
        carteiraNome = nomesOficiais[base] + (ehCredito ? " Crédito" : "");
      } else {
        carteiraNome = "Dinheiro";
      }
      
      const walletExists = await Wallet.findOne({ phone, nome: carteiraNome });
      if (!walletExists && carteiraNome !== "Dinheiro") {
        const count = await Wallet.countDocuments({ phone });
        if (count >= 3) {
          await sendZap(phone, "⚠️ Você já tem 3 contas. Não é possível adicionar mais. Use 'deletar conta' se necessário.");
          return;
        }
      }

      const idTransacao = nanoid(6);
      const isPago = (data.pago === false || data.pago === "false") ? false : true;
      let dataVenc = new Date();
      if (data.vencimento) {
        const dataTentativa = new Date(data.vencimento);
        if (!isNaN(dataTentativa.getTime())) dataVenc = dataTentativa;
      }

      await Finance.create({ phone, idCurto: idTransacao, tipo: data.tipo, categoria: data.categoria, valor: valorLimpo, observacao: `${data.observacao || ''} [${carteiraNome}]`, pago: isPago, recorrente: data.recorrente, vencimento: dataVenc });

      if (isPago) {
        const multiplicador = (data.tipo === "Gasto" ? -1 : 1);
        await Wallet.findOneAndUpdate(
          { phone, nome: carteiraNome },
          { $inc: { saldo: valorLimpo * multiplicador }, $set: { tipo: ehCredito ? "Crédito" : "Corrente" } },
          { upsert: true }
        );
      }

      if (data.tipo === "Gasto") {
        await verificarLimiteCategoria(phone, data.categoria, valorLimpo);
      }

      const emojiCategoria = EMOJIS_CATEGORIAS[data.categoria] || "🔖";
      const iconeTipo = data.tipo === "Gasto" ? "🟥 Despesa" : "🟩 Receita";
      const iconePago = isPago ? "✅" : "❌ (Pendente)";
      const txtRecorrente = data.recorrente ? "\n🔁 Frequência: Fixo Mensal" : "";
      const dataF = dataVenc.toLocaleDateString('pt-BR');
      const msgPremium = `*Transação registrada!*\n\nIdentificador: ${idTransacao}\n\n${emojiCategoria} Descrição: ${data.observacao || 'Lançamento'}\n💸 Valor: R$ ${valorLimpo.toFixed(2)}\n🔄 Tipo: ${iconeTipo}\n🏷 Categoria: ${data.categoria}\n🏦 Conta: ${carteiraNome}\n🗓 Data: ${dataF}\n💵 Pago: ${iconePago}${txtRecorrente}\n\n❌ Para excluir: "Excluir transação ${idTransacao}".\n\n📊 Painel: https://zecadocaixa.lovable.app/?phone=${phone}`;
      await sendZapMenu(phone, msgPremium);
    }
    else if (data.acao === "resumo") {
      const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
      const categorias = await Finance.aggregate([
        { $match: { phone, tipo: "Gasto", data: { $gte: inicioMes } } },
        { $group: { _id: "$categoria", total: { $sum: "$valor" } } },
        { $sort: { total: -1 } }
      ]);
      const todos = await Finance.find({ phone, data: { $gte: inicioMes } });
      let g = 0, r = 0;
      todos.forEach(i => i.tipo === "Gasto" ? g += i.valor : r += i.valor);
      let txtCat = categorias.map(c => `${EMOJIS_CATEGORIAS[c._id] || "🔹"} *${c._id}:* R$ ${c.total.toFixed(2)}`).join('\n') || "Sem gastos.";
      let statusMeta = user.metaMensal > 0 ? `\n🎯 Meta: R$ ${user.metaMensal} (${((g/user.metaMensal)*100).toFixed(0)}%)` : "";
      await sendZap(phone, `👴 *RESUMO DO MÊS:*\n\n${txtCat}\n\n🔴 Gastos: R$ ${g.toFixed(2)}\n🟢 Receitas: R$ ${r.toFixed(2)}\n💰 *SALDO: R$ ${(r-g).toFixed(2)}*${statusMeta}\n\n🌐 https://zecadocaixa.lovable.app/?phone=${phone}`);
    }
    else {
      await sendZap(phone, data.resposta || "Como posso ajudar?");
    }
  } catch (error) {
    console.log("Erro no webhook:", error.message);
    await sendZap(phone, "Ocorreu um erro interno. Tente novamente mais tarde.");
  }
});

// --- ROTAS DA API ---
function authMiddleware(req, res, next) {
  const token = req.query.token || req.headers['x-api-token'];
  if (!API_SECRET_TOKEN || token === API_SECRET_TOKEN) return next();
  res.status(401).json({ erro: "Não autorizado" });
}

app.get("/api/transacoes/:phone", authMiddleware, async (req, res) => {
  try {
    const { phone } = req.params;
    const transacoes = await Finance.find({ phone }).sort({ data: -1 });
    res.json(transacoes);
  } catch (error) {
    res.status(500).json({ erro: "Erro ao buscar dados" });
  }
});

app.post("/api/importar-ofx", authMiddleware, async (req, res) => {
  res.json({ msg: "Funcionalidade OFX em breve" });
});

// --- CRON JOB ---
cron.schedule('0 * * * *', async () => {
  console.log("Processando recorrências e lembretes...");
  const hoje = new Date();
  const dia = hoje.getDate();
  const inicioHoje = new Date(); inicioHoje.setHours(0,0,0,0);
  const fimHoje = new Date(); fimHoje.setHours(23,59,59,999);

  const contasHoje = await Recorrencia.find({ diaVencimento: dia, ativa: true });
  for (const conta of contasHoje) {
    const jaLancado = await Finance.findOne({ phone: conta.phone, categoria: conta.categoria, valor: conta.valor, data: { $gte: inicioHoje, $lte: fimHoje } });
    if (!jaLancado) {
      const idTransacao = nanoid(6);
      const carteiraAlvo = conta.carteira || "DINHEIRO";
      await Finance.create({ phone: conta.phone, idCurto: idTransacao, tipo: conta.tipo, categoria: conta.categoria, valor: conta.valor, observacao: `[Recorrente] ${conta.descricao || ''} [${carteiraAlvo}]` });
      await Wallet.findOneAndUpdate({ phone: conta.phone, nome: carteiraAlvo }, { $inc: { saldo: conta.tipo === "Gasto" ? -conta.valor : conta.valor } });
      await sendZap(conta.phone, `👴 *Zeca avisando:* Registrei o gasto fixo de R$ ${conta.valor.toFixed(2)} no ${carteiraAlvo}! (ID: ${idTransacao})`);
    }
  }

  const amanha = new Date(); amanha.setDate(hoje.getDate() + 1);
  const proximosDias = [hoje, amanha];
  for (const diaRef of proximosDias) {
    const lembretes = await Reminder.find({ dataVencimento: { $gte: diaRef, $lt: new Date(diaRef.getTime() + 86400000) }, enviado: false, ativo: true });
    for (const lembrete of lembretes) {
      const diffDias = Math.ceil((lembrete.dataVencimento - hoje) / (1000 * 60 * 60 * 24));
      if (diffDias <= lembrete.diasAntecedencia && diffDias >= 0) {
        await sendZap(lembrete.phone, `🔔 *LEMBRETE*: ${lembrete.tipo === "pagar" ? "💸 Pagar" : "💰 Receber"} *${lembrete.descricao}* no valor de R$ ${lembrete.valor.toFixed(2)} até ${lembrete.dataVencimento.toLocaleDateString('pt-BR')}.`);
        if (diffDias === 0) lembrete.enviado = true;
        await lembrete.save();
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot Zeca do Caixa rodando na porta ${PORT} 🚀`));
