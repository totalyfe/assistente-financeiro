require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const cors = require('cors');
const fs = require('fs');
const FormData = require('form-data');
const { nanoid } = require('nanoid');
const cron = require('node-cron');
const yahooFinance = require('yahoo-finance2').default;

const app = express();
app.use(cors());
app.use(express.json());

const { 
  OPENAI_API_KEY, ZAPI_TOKEN, ZAPI_INSTANCE, MONGODB_URI, ZAPI_CLIENT_TOKEN, API_SECRET_TOKEN, GOOGLE_CLOUD_API_KEY
} = process.env;

if (!API_SECRET_TOKEN) console.warn("⚠️ API_SECRET_TOKEN não definido. Rotas da API estarão desprotegidas.");

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB conectado 🔥"))
  .catch(err => console.log("Erro MongoDB:", err));

// --- CONFIGURAÇÃO DE EMOJIS CENTRALIZADA ---
const EMOJIS_CATEGORIAS = { 
  "Mercado": "🛒", "Transporte": "🚗", "Lazer e Entretenimento": "🍺", "Saúde": "💊", "Aluguel": "🏠",
  "Educação": "📚", "Casa": "🏠", "Salário": "💰", "Alimentação": "🧃", "Recebimento": "💰", 
  "Transferências": "🔄", "Internet": "🛜", "Pet": "🐶", "Padaria": "🥖", "Assinaturas": "📺", "Vestuário": "👕",
  "Impostos": "📉", "Viagem": "✈️", "Doações": "🏷️", "Outros": "📦" 
};

// --- TEXTOS DE AJUDA ---
const HELP_TEXT = `━━━━━━━━━━

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

━━━━━━━━━━

🔍 *Buscar gastos*
- "gastos"
- "gastos mercado"
- "o que gastei essa semana"

❌ *Excluir lançamento*
- "excluir última"
- "excluir transação ABC12"

━━━━━━━━━━

🗂 *Organização automática*
- Eu classifico tudo sozinho por categoria ✅

━━━━━━━━━━

🏦 *Contas (bancos)*
- "nubank 1000"
- "adicionar 200 no inter"
- "mude meu saldo do nubank pra 2000"
- "qual meu saldo?"

💳 *Cartão de crédito parcelado*
- "comprei [desc] no [cartão] em 3x de 140"
- "pagar parcela da [desc]"
- "definir fatura dia 15"

━━━━━━━━━━

💸 *Transferências*
- "transferir 200 do nubank pro inter"

🔁 *Contas fixas (recorrentes)*
- "todo mês 1000 aluguel dia 5"

🎯 *Limite mensal de gastos*
- "limite 2000"
- "limite geral 2000"
*Ou por categoria:*
- "Limite Lazer e Entretenimento 500"

🔔 *Alertas*
- "limite mercado 500"
- "meus limites"

📈 *Relatórios*
- Gráficos e relatórios no painel

🧠 *Análise inteligente*
- "analisar"

🚀 Vamos começar? Me manda seu primeiro lançamento!

━━━━━━━━━━`;

const WELCOME_TEXT = `👋 *Olá %nome%! Seja muito bem vindo(a), eu sou a Sora!* 💰

Vou te ensinar rapidinho como organizar sua vida financeira aqui no WhatsApp 👇

${HELP_TEXT}`;

// ========== MODELOS DE GRUPOS ==========
const Grupo = mongoose.model("Grupo", new mongoose.Schema({
  nome: { type: String, required: true },
  donoId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  membros: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    papel: { type: String, enum: ["admin", "leitura", "escrita"], default: "escrita" }
  }],
  codigoConvite: { type: String, sparse: true },
  createdAt: { type: Date, default: Date.now }
}));

const Convite = mongoose.model("Convite", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  codigo: { type: String, unique: true, required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  expiraEm: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, // 7 dias
  usado: { type: Boolean, default: false }
}));

// --- MODELOS EXISTENTES (modificados para incluir grupoId) ---
const Wallet = mongoose.model("Wallet", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  nome: { type: String, required: true },
  tipo: { type: String, enum: ["Corrente", "Crédito", "Poupança", "Vale Alimentação", "Dinheiro"], default: "Corrente" },
  saldo: { type: Number, default: 0 },
  limite: { type: Number, default: 0 },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" } // opcional
}));

const Finance = mongoose.model("Finance", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  idCurto: { type: String, unique: true },
  tipo: String,
  categoria: String,
  valor: Number,
  observacao: String,
  pago: { type: Boolean, default: true },
  recorrente: { type: Boolean, default: false },
  vencimento: { type: Date, default: Date.now },
  data: { type: Date, default: Date.now },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
}));

const User = mongoose.model("User", new mongoose.Schema({
  phone: String,
  name: String,
  metaMensal: { type: Number, default: 0 },
  email: { type: String, default: '' },
  plano: { type: String, enum: ['inativo', 'basico', 'premium', 'black'], default: 'inativo' },
  intervalo: { type: String, default: 'month' },
  validoAte: { type: Date, default: null },
  diaFechamentoFatura: { type: Number, default: 10 },
  ultimoFechamento: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  rendaMediaMensal: { type: Number, default: 0 },
  ultimaAtualizacaoRenda: { type: Date, default: null },
  grupoAtivo: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", default: null }
}));

const Recorrencia = mongoose.model("Recorrencia", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  tipo: { type: String, default: "Gasto" },
  categoria: String,
  valor: Number,
  diaVencimento: Number,
  descricao: String,
  carteira: { type: String, default: "DINHEIRO" },
  ativa: { type: Boolean, default: true }
}));

const CategoryLimit = mongoose.model("CategoryLimit", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  categoria: String,
  limiteMensal: Number,
  mesReferencia: { type: String, default: () => new Date().toISOString().slice(0,7) },
  percentualAlerta: { type: Number, default: 80 },
  alertaEnviado: { type: Boolean, default: false }
}));

const Reminder = mongoose.model("Reminder", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  descricao: String,
  valor: Number,
  tipo: { type: String, enum: ["pagar", "receber"] },
  dataVencimento: Date,
  diasAntecedencia: { type: Number, default: 2 },
  enviado: { type: Boolean, default: false },
  ativo: { type: Boolean, default: true }
}));

const Parcela = mongoose.model("Parcela", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  descricao: String,
  valorTotal: Number,
  valorParcela: Number,
  totalParcelas: Number,
  parcelasPagas: { type: Number, default: 0 },
  dataProximaVencimento: Date,
  categoria: String,
  carteira: String,
  ativa: { type: Boolean, default: true }
}));

const Categoria = mongoose.model("Categoria", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  nome: { type: String, required: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: "Categoria" },
  icone: { type: String, default: "📦" },
  cor: { type: String, default: "#808080" },
  arquivada: { type: Boolean, default: false },
  ativa: { type: Boolean, default: true }
}));

const Investimento = mongoose.model("Investimento", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  tipo: { type: String, enum: [
    "Tesouro Direto", "CDB/CDI", "Ações", "FIIs", "ETFs",
    "Cripto", "Previdência", "Fundos", "Reserva de Emergência",
    "Imóveis", "Negócios próprios", "Caixa"
  ], required: true },
  nome: { type: String, required: true },
  quantidade: { type: Number, default: 0 },
  precoUnitario: { type: Number, default: 0 },
  valorAportado: { type: Number, default: 0 },
  dataCompra: { type: Date, default: Date.now },
  valorAtual: { type: Number, default: 0 },
  rentabilidade: { type: Number, default: 0 },
  ticker: { type: String, default: null, index: true },           // ex: "PETR4.SA", "AAPL", "BTC-USD"
  dividendosAcumulados: { type: Number, default: 0 }, // total de proventos já recebidos
  ultimoDividendo: { type: Number, default: 0 },      // valor do último dividendo pago (opcional)
  dataUltimoDividendo: { type: Date, default: null },  // data do último dividendo registrado (opcional)
  ultimaAtualizacao: { type: Date, default: Date.now }
}));

const Aporte = mongoose.model("Aporte", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  data: { type: Date, default: Date.now },
  valor: Number,
  investimentoId: { type: mongoose.Schema.Types.ObjectId, ref: "Investimento" },
  descricao: { type: String, default: "" }
}));

const Meta = mongoose.model("Meta", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  nome: { type: String, required: true },
  valorObjetivo: Number,
  prazoAnos: Number,
  aporteMensalSugerido: Number,
  taxaAnual: { type: Number, default: 0.1 },
  investimentoId: { type: mongoose.Schema.Types.ObjectId, ref: "Investimento" },
  status: { type: String, enum: ["em andamento", "concluída", "atrasada"], default: "em andamento" },
  dataCriacao: { type: Date, default: Date.now }
}));

const HistoricoInvestimento = mongoose.model("HistoricoInvestimento", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  investimentoId: { type: mongoose.Schema.Types.ObjectId, ref: "Investimento" },
  data: { type: Date, default: Date.now },
  valorAtual: Number
}));

const PatrimonioHistorico = mongoose.model("PatrimonioHistorico", new mongoose.Schema({
  grupoId: { type: mongoose.Schema.Types.ObjectId, ref: "Grupo", required: true },
  data: { type: Date, default: Date.now },
  patrimonioTotal: Number,
  rentabilidadePeriodo: Number
}));

// ========== FUNÇÕES AUXILIARES ==========

// Normaliza telefone: remove tudo que não é dígito, mantém o código do país original
function normalizarPhone(phone) {
  if (!phone) return phone;
  return phone.replace(/\D/g, '');
}

async function obterGrupoIdPorPhone(phone) {
  const normalizedPhone = normalizarPhone(phone);
  const user = await User.findOne({ phone: normalizedPhone });
  if (!user || !user.grupoAtivo) return null;
  return user.grupoAtivo;
}

async function verificarPlanoInvestimentos(phone) {
  const normalizedPhone = normalizarPhone(phone);
  const user = await User.findOne({ phone: normalizedPhone });
  return user && user.plano === 'black';
}

async function verificarLimiteMembros(grupoId, planoDono) {
  const grupo = await Grupo.findById(grupoId);
  if (!grupo) return false;
  const membrosAtuais = grupo.membros.length + 1; // +1 pelo dono
  if (planoDono === 'basico') return membrosAtuais <= 1;
  if (planoDono === 'premium') return membrosAtuais <= 3;
  if (planoDono === 'black') return membrosAtuais <= 5;
  return false;
}

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

// ========== FUNÇÃO PARA OCR COM GOOGLE CLOUD VISION (USANDO API KEY) ==========
async function processarNotaFiscalComGoogleVision(imageUrl) {
  if (!GOOGLE_CLOUD_API_KEY) {
    console.warn("Google Cloud API key não configurada");
    return null;
  }
  try {
    // Baixar a imagem
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');

    // Chamar a API REST do Google Cloud Vision
    const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_CLOUD_API_KEY}`;
    const requestBody = {
      requests: [{
        image: { content: imageBase64 },
        features: [{ type: "TEXT_DETECTION" }]
      }]
    };

    const response = await axios.post(visionUrl, requestBody, {
      headers: { 'Content-Type': 'application/json' }
    });

    const textAnnotations = response.data.responses[0]?.textAnnotations;
    if (!textAnnotations || textAnnotations.length === 0) {
      console.log("Nenhum texto encontrado na imagem");
      return null;
    }

    const fullText = textAnnotations[0].description;
    console.log("Texto extraído da nota fiscal:", fullText);

    // Extrair valor (prioriza padrão com R$)
    let valor = null;
    let valorMatch = fullText.match(/R?\$?\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/i);
    if (!valorMatch) {
      valorMatch = fullText.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/);
    }
    if (valorMatch) {
      let valorStr = valorMatch[1].replace(/\./g, '').replace(',', '.');
      valor = parseFloat(valorStr);
    }

    // Extrair estabelecimento (primeira linha não vazia)
    const linhas = fullText.split('\n').filter(l => l.trim().length > 0);
    const estabelecimento = linhas[0]?.trim() || "Compra";

    return {
      valor,
      estabelecimento,
      texto: fullText,
      categoria: detectarCategoria(estabelecimento)
    };
  } catch (err) {
    console.error("Erro no OCR com Google Cloud Vision:", err.message);
    if (err.response) console.error("Detalhe do erro da API:", err.response.data);
    return null;
  }
}

function detectarCategoria(msg) {
  const m = msg.toLowerCase();
  if (m.includes("mercado")) return "Mercado";
  if (m.match(/(uber|99|gasolina|combustivel|posto|carro)/i)) return "Transporte";
  if (m.match(/(pizza|lanche|restaurante|comer|janta)/i)) return "Alimentação";
  if (m.match(/(netflix|spotify|prime|hbo|disney)/i)) return "Assinaturas";
  if (m.match(/(farmacia|remedio|medico|hospital|saude)/i)) return "Saúde";
  if (m.includes("aluguel")) return "Aluguel";
  if (m.match(/(padaria|pao|cafe)/i)) return "Padaria";
  if (m.match(/(internet|wifi|wi-fi|vivo|claro|tim)/i)) return "Internet";
  if (m.match(/(pet|dog|gato|racao|veterinario)/i)) return "Pet";
  if (m.match(/(lazer|cerveja|breja|role|cinema)/i)) return "Lazer";
  if (m.includes("pix")) return "Transferências";
  return "Outros";
}

function interpretarRapido(message) {
  const msg = message.toLowerCase();
// ⭐ NOVO: Detectar pedido de dicas
  if (msg.match(/dicas|economizar|sugestões|como economizar|me ajuda a economizar/i)) {
    return { acao: "gerar_dicas" };
  }
  // --- Comandos de grupo ---
  const criarGrupoMatch = msg.match(/criar\s+grupo\s+(.+)/i);
  if (criarGrupoMatch) {
    return { acao: "criar_grupo", nome: criarGrupoMatch[1].trim() };
  }
  const convidarMatch = msg.match(/convidar\s+grupo/i);
  if (convidarMatch) {
    return { acao: "convidar_grupo" };
  }
  const entrarGrupoMatch = msg.match(/entrar\s+grupo\s+([A-Z0-9]{6,8})/i);
  if (entrarGrupoMatch) {
    return { acao: "entrar_grupo", codigo: entrarGrupoMatch[1].toUpperCase() };
  }
  const meusGruposMatch = msg.match(/meus\s+grupos/i);
  if (meusGruposMatch) {
    return { acao: "meus_grupos" };
  }
  const trocarGrupoMatch = msg.match(/trocar\s+grupo\s+(.+)/i);
  if (trocarGrupoMatch) {
    return { acao: "trocar_grupo", nome: trocarGrupoMatch[1].trim() };
  }
  const membrosMatch = msg.match(/membros/i);
  if (membrosMatch) {
    return { acao: "listar_membros" };
  }
  const removerMembroMatch = msg.match(/remover\s+membro\s+(.+)/i);
  if (removerMembroMatch) {
    return { acao: "remover_membro", nome: removerMembroMatch[1].trim() };
  }

  const recorrenteMatch = msg.match(/todo\s+mês\s+(\d+(?:[.,]\d{2})?)\s+(.+?)\s+dia\s+(\d{1,2})/i);
  if (recorrenteMatch) {
    return {
      acao: "set_recorrente",
      valor: parseFloat(recorrenteMatch[1].replace(',', '.')),
      descricao: recorrenteMatch[2].trim(),
      dia: parseInt(recorrenteMatch[3])
    };
  }

  const cancelarRecorrênciaMatch = msg.match(/(cancelar|parar)\s+recorr[eê]ncia\s+(.+)/i);
  if (cancelarRecorrênciaMatch) {
    return {
      acao: "cancelar_recorrencia",
      descricao: cancelarRecorrênciaMatch[2].trim()
    };
  }

  const deletarContaMatch = msg.match(/deletar\s+conta\s+(.+)/i);
  if (deletarContaMatch) {
    return { acao: "deletar_conta", nome: deletarContaMatch[1].trim().toUpperCase() };
  }
  const parceladoMatch = msg.match(/(?:comprei|fiz uma compra de)\s+(.+?)\s+(?:no|na|pelo)\s+([a-zà-ú\s]+(?: crédito)?)\s+em\s+(\d+)x\s+de\s+(\d+(?:[.,]\d{2})?)/i);
  if (parceladoMatch) {
    const descricao = parceladoMatch[1].trim();
    const carteira = parceladoMatch[2].trim().toUpperCase();
    const numParcelas = parseInt(parceladoMatch[3]);
    let valorParcela = parseFloat(parceladoMatch[4].replace(',', '.'));
    const valorTotal = numParcelas * valorParcela;
    return {
      acao: "compra_parcelada",
      descricao, carteira, numParcelas, valorParcela, valorTotal,
      categoria: detectarCategoria(descricao)
    };
  }
  const pagarParcelaMatch = msg.match(/pagar\s+parcela\s+da\s+(.+)/i);
  if (pagarParcelaMatch) {
    return { acao: "pagar_parcela", descricao: pagarParcelaMatch[1].trim() };
  }
  // 🆕 NOVO: Capturar confirmação de pagamento de parcela
const parcelaPagaMatch = msg.match(/parcela\s+paga\s+(.+)/i);
if (parcelaPagaMatch) {
  return { acao: "confirmar_pagamento_parcela", descricao: parcelaPagaMatch[1].trim() };
}
  const faturaDiaMatch = msg.match(/definir\s+fatura\s+dia\s+(\d{1,2})/i);
  if (faturaDiaMatch) {
    return { acao: "set_fatura_dia", dia: parseInt(faturaDiaMatch[1]) };
  }
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
      acao: "salvar", tipo: "Gasto",
      valor: parseFloat(gastoMatch[2].replace(',', '.')),
      categoria: detectarCategoria(categoriaTexto), carteira: carteiraDetectada,
      observacao: message, pago: true, recorrente: false
    };
  }
  const receitaMatch = msg.match(/(ganhei|recebi|caiu|depositaram)\s+(\d+(?:[.,]\d{2})?)(?:\s+(?:no|na|pelo)\s+([a-z0-9à-ú\s]+))?/i);
  if (receitaMatch) {
    return {
      acao: "salvar", tipo: "Recebimento",
      valor: parseFloat(receitaMatch[2].replace(',', '.')),
      categoria: "Recebimento", carteira: receitaMatch[3] ? receitaMatch[3].toUpperCase() : null,
      observacao: message, pago: true, recorrente: false
    };
  }
    const setWalletMatch = msg.match(/^([a-zà-ú\s]+(?: crédito)?)\s+(\d+(?:[.,]\d{2})?)$/i);
  if (setWalletMatch) {
    let nomeConta = setWalletMatch[1].trim();
    let valor = parseFloat(setWalletMatch[2].replace(',', '.'));
    if (isNaN(valor)) valor = 0;
    return { acao: "set_wallet", nome: nomeConta, valor: valor };
  }

  // Comandos de navegação e ajuda
  if (msg.includes("painel")) return { acao: "painel" };
  if (msg.match(/(funções|funcoes|ajuda|help|menu|o que você faz)/i)) return { acao: "ajuda" };

  // Comandos de consulta rápida
  if (msg.includes("gastos") || msg.includes("compras")) return { acao: "buscar", termo: "TUDO" };
  if (msg.match(/(resumo|relatorio|relatório)/i)) return { acao: "resumo" };
  if (msg.includes("saldo")) return { acao: "ver_saldos" };
  if (msg.includes("dividendos") || msg.includes("proventos")) return { acao: "ver_dividendos" };

  // 🆕 Limite geral (meta mensal) – substitui o antigo comando "meta"
  const limiteGeralMatch = msg.match(/^limite\s+geral\s+(\d+(?:[.,]\d{2})?)$/i);
  if (limiteGeralMatch) {
    return { acao: "set_meta", valor: parseFloat(limiteGeralMatch[1].replace(',', '.')) };
  }
  const limiteSimplesMatch = msg.match(/^limite\s+(\d+(?:[.,]\d{2})?)$/i);
  if (limiteSimplesMatch) {
    return { acao: "set_meta", valor: parseFloat(limiteSimplesMatch[1].replace(',', '.')) };
  }

  // Limite por categoria
  const limiteMatch = msg.match(/limite\s+([a-zà-ú]+)\s+(\d+(?:[.,]\d{2})?)/i);
  if (limiteMatch) return { acao: "set_limite", categoria: limiteMatch[1], valor: parseFloat(limiteMatch[2].replace(',', '.')) };
  if (msg.includes("meus limites")) return { acao: "meus_limites" };

  // Lembretes
  const lembreteMatch = msg.match(/(lembrar|lembrete)\s+(pagar|receber)\s+(.+)\s+dia\s+(\d{1,2})\/(\d{1,2})\s+valor\s+(\d+(?:[.,]\d{2})?)/i);
  if (lembreteMatch) {
    return {
      acao: "criar_lembrete", tipo: lembreteMatch[2], descricao: lembreteMatch[3],
      dia: parseInt(lembreteMatch[4]), mes: parseInt(lembreteMatch[5]) - 1,
      valor: parseFloat(lembreteMatch[6].replace(',', '.'))
    };
  }

  // Exclusão de transações
  if (msg.match(/(excluir|apagar|deletar)/i)) {
    if (msg.match(/(ultima|última)/i)) return { acao: "apagar" };
    const idMatch = msg.match(/([A-Z0-9]{6})/i);
    return { acao: "apagar", idCurto: idMatch ? idMatch[1].toUpperCase() : null };
  }

  return null;
}   

async function verificarLimiteCategoria(grupoId, categoria, valorGasto, phone) {
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);

  // Total de gastos no mês para a categoria
  const gastosMes = await Finance.aggregate([
    { $match: { grupoId, categoria, tipo: "Gasto", data: { $gte: inicioMes } } },
    { $group: { _id: null, total: { $sum: "$valor" } } }
  ]);
  const totalAtual = gastosMes[0]?.total || 0;
  const novoTotal = totalAtual + valorGasto;

  // Busca o limite configurado para esta categoria no mês atual
  const mesRef = new Date().toISOString().slice(0, 7);
  const limiteDoc = await CategoryLimit.findOne({ grupoId, categoria, mesReferencia: mesRef });

  if (limiteDoc && limiteDoc.limiteMensal > 0) {
    const percentual = (novoTotal / limiteDoc.limiteMensal) * 100;
    const alertaPercent = limiteDoc.percentualAlerta || 80;

    // Só envia alerta se atingiu o percentual e ainda não foi enviado este mês
    if (percentual >= alertaPercent && !limiteDoc.alertaEnviado) {
      await sendZap(phone, `⚠️ *Atenção!* Você atingiu ${percentual.toFixed(0)}% do limite de *${categoria}*.\nLimite: R$ ${limiteDoc.limiteMensal.toFixed(2)} | Gasto atual: R$ ${novoTotal.toFixed(2)}`);
      
      // Marca o alerta como enviado para não repetir
      await CategoryLimit.updateOne({ _id: limiteDoc._id }, { alertaEnviado: true });
    }
  }
}

// --- FUNÇÕES AUXILIARES PARA RENDA E AJUSTE DE METAS (adaptadas para grupoId) ---
async function atualizarRendaMedia(grupoId) {
  // A renda média é do grupo (soma de receitas do grupo)
  const seisMesesAtras = new Date();
  seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
  const receitas = await Finance.aggregate([
    { $match: { grupoId, tipo: "Recebimento", data: { $gte: seisMesesAtras } } },
    { $group: { _id: null, total: { $sum: "$valor" } } }
  ]);
  const totalReceitas = receitas[0]?.total || 0;
  const meses = 6;
  const novaRendaMedia = totalReceitas / meses;
  // Não há um campo rendaMediaMensal por grupo; seria necessário armazenar no grupo ou recalcular sempre. Por simplicidade, vamos manter a lógica antiga (baseada no phone) mas agora usaremos grupoId.
  // Para não complicar, criamos uma coleção separada? Por ora, ignoramos ou mantemos no usuário (mas grupo pode ter múltiplos usuários). Deixaremos como estava (phone) - não é ideal, mas para MVP.
  // Vamos pular essa atualização por enquanto.
}

// - - - DICAS FINANCEIRAS - - -
async function gerarDicasFinanceiras(grupoId, phone) {
  // Buscar transações dos últimos 30 dias
  const trintaDiasAtras = new Date();
  trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
  
  const transacoes = await Finance.find({
    grupoId,
    data: { $gte: trintaDiasAtras }
  }).sort({ data: -1 });

  if (transacoes.length === 0) {
    return "Você ainda não tem transações nos últimos 30 dias. Registre alguns gastos para que eu possa te dar dicas personalizadas.";
  }

  // Agrupar gastos por categoria (apenas despesas)
  const gastosPorCategoria = {};
  let totalGastos = 0;
  for (const t of transacoes) {
    if (t.tipo === "Gasto") {
      totalGastos += t.valor;
      const cat = t.categoria;
      gastosPorCategoria[cat] = (gastosPorCategoria[cat] || 0) + t.valor;
    }
  }

  // Ordenar categorias por maior gasto
  const categoriasOrdenadas = Object.entries(gastosPorCategoria)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 5); // top 5

  // Construir resumo para o GPT
  let resumo = `Últimos 30 dias:\nTotal de gastos: R$ ${totalGastos.toFixed(2)}\n`;
  for (const [cat, valor] of categoriasOrdenadas) {
    resumo += `- ${cat}: R$ ${valor.toFixed(2)}\n`;
  }

  // Chamar o GPT para gerar dicas personalizadas
  const prompt = `Você é um especialista em finanças pessoais. Com base no seguinte resumo de gastos de um usuário, gere **dicas práticas e específicas** para ele economizar dinheiro. Seja direto, amigável e evite conselhos genéricos. Aponte onde ele pode cortar gastos e sugira alternativas concretas.

Resumo:
${resumo}

Dicas:`;

  const response = await axios.post("https://api.openai.com/v1/chat/completions", {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7
  }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

  return response.data.choices[0].message.content;
}

// ========== INTEGRAÇÃO COM YAHOO FINANCE ==========
async function buscarDadosYahoo(ticker, dataCompra) {
  try {
    // Busca cotação atual
    const quote = await yahooFinance.quote(ticker);
    const precoAtual = quote.regularMarketPrice;
    
    // Busca dividendos históricos (se disponíveis)
    // Nota: a carteira 'historical' com parâmetro 'events' funciona para ações e FIIs,
    // mas para alguns ativos (ex: ETFs acumuladores) pode retornar vazio
    let dividendosAcumulados = 0;
    try {
      const historico = await yahooFinance.historical(ticker, {
        period1: dataCompra,        // desde a data da compra
        events: 'dividends'
      });
      // Soma todos os dividendos pagos no período
      for (const item of historico) {
        if (item.dividends) dividendosAcumulados += item.dividends;
      }
    } catch (err) {
      console.log(`Sem dividendos ou erro ao buscar para ${ticker}:`, err.message);
    }
    
    return { precoAtual, dividendosAcumulados };
  } catch (err) {
    console.error(`Erro ao buscar dados do Yahoo para ${ticker}:`, err.message);
    return null;
  }
}

// ========== WEBHOOK PRINCIPAL (adaptado para grupos) ==========
app.post("/webhook", async (req, res) => {
  let { phone, text, listResponseMessage, audio, image, fromMe } = req.body;
  // Normaliza o telefone assim que chega
  phone = normalizarPhone(phone);
  res.sendStatus(200);
  if (fromMe === true) return;

  let message = text?.message || listResponseMessage?.title;

  if (audio && audio.audioUrl) {
    try {
      message = await transcreverAudio(audio.audioUrl, phone);
      console.log(`Sora ouviu: "${message}"`);
    } catch (err) {
      await sendZap(phone, "Não consegui compreender seu áudio, pode repetir?");
      return;
    }
  }

  // --- PROCESSAMENTO DE IMAGEM (nota fiscal) - APENAS PARA PLANOS PREMIUM OU BLACK ---
  if (image && image.url && GOOGLE_CLOUD_API_KEY) {
    // Verificar plano do usuário (buscar no banco)
    const user = await User.findOne({ phone });
    const isPremiumOrBlack = user && (user.plano === 'premium' || user.plano === 'black');
    
    if (!isPremiumOrBlack) {
      await sendZap(phone, "🚫 A funcionalidade de leitura de notas fiscais está disponível apenas nos planos Premium e Black. Faça upgrade pelo nosso painel.");
      return;
    }

    try {
      const ocrResult = await processarNotaFiscalComGoogleVision(image.url);
      if (ocrResult && ocrResult.valor && ocrResult.valor > 0) {
        message = `gastei ${ocrResult.valor.toFixed(2)} ${ocrResult.estabelecimento}`;
        console.log(`Imagem processada: valor ${ocrResult.valor} - ${ocrResult.estabelecimento}`);
      } else {
        await sendZap(phone, "Não consegui identificar o valor da nota fiscal. Por favor, registre manualmente com 'gastei valor descrição'.");
        return;
      }
    } catch (err) {
      console.error("Erro ao processar imagem:", err);
      await sendZap(phone, "Erro ao processar a imagem. Tente novamente ou registre manualmente.");
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
        user = await User.create({ phone, name: extractedName });
        // Criar grupo pessoal para o novo usuário
        const grupo = await Grupo.create({
          nome: "Pessoal",
          donoId: user._id,
          membros: [{ userId: user._id, papel: "admin" }],
          codigoConvite: null
        });
        user.grupoAtivo = grupo._id;
        await user.save();
        // Migrar categorias padrão para o grupo
        await criarCategoriasPadrao(grupo._id);
        await sendZapMenu(phone, WELCOME_TEXT.replace("%nome%", extractedName));
        return;
      }
    }

    // Obter grupo ativo do usuário
    const grupoId = user.grupoAtivo;
    if (!grupoId) {
      // Se não tiver grupo, criar um pessoal
      const novoGrupo = await Grupo.create({
        nome: "Pessoal",
        donoId: user._id,
        membros: [{ userId: user._id, papel: "admin" }]
      });
      user.grupoAtivo = novoGrupo._id;
      await user.save();
    }
    const grupoAtual = await Grupo.findById(user.grupoAtivo);
    if (!grupoAtual) {
      await sendZap(phone, "Erro: grupo não encontrado. Entre em contato com o suporte.");
      return;
    }

    let data = interpretarRapido(message);
    if (!data) {
      // Buscar dados do grupo para o GPT (investimentos, metas, saldo)
      const investimentos = await Investimento.find({ grupoId: grupoAtual._id });
      const metas = await Meta.find({ grupoId: grupoAtual._id });
      const saldoGeral = await Wallet.aggregate([
        { $match: { grupoId: grupoAtual._id } },
        { $group: { _id: null, total: { $sum: "$saldo" } } }
      ]);
      const totalSaldo = saldoGeral[0]?.total || 0;

      let resumoInvestimentos = "Nenhum investimento cadastrado.";
      if (investimentos.length) {
        let totalInvestido = 0, totalAtual = 0;
        const lista = investimentos.map(i => {
          totalInvestido += i.valorAportado;
          totalAtual += i.valorAtual;
          return `${i.nome} (${i.tipo}): investido R$ ${i.valorAportado}, atual R$ ${i.valorAtual} (${((i.rentabilidade||0)*100).toFixed(1)}%)`;
        }).join('\n');
        resumoInvestimentos = `Total investido: R$ ${totalInvestido}\nTotal atual: R$ ${totalAtual}\nRentabilidade total: ${(((totalAtual-totalInvestido)/totalInvestido)*100).toFixed(2)}%\nDetalhes:\n${lista}`;
      }

      let resumoMetas = "Nenhuma meta financeira cadastrada.";
      if (metas.length) {
        const listaMetas = metas.map(m => 
          `${m.nome}: objetivo R$ ${m.valorObjetivo} em ${m.prazoAnos} anos, aporte mensal sugerido R$ ${m.aporteMensalSugerido}`
        ).join('\n');
        resumoMetas = listaMetas;
      }

      const systemPrompt = `Você é a **Sora**, assistente financeira pessoal do grupo "${grupoAtual.nome}". 
Abaixo está uma descrição completa das minhas funcionalidades. Use-a para responder perguntas dos usuários sobre como usar o bot.
Você deve responder de forma natural, amigável e útil, sempre em português.

**Dados atuais do grupo:**
- Saldo total em contas: R$ ${totalSaldo}
- Investimentos: ${resumoInvestimentos}
- Metas financeiras: ${resumoMetas}

**Instruções importantes:**
1. Se o usuário perguntar sobre qualquer um desses dados, responda diretamente usando as informações acima.
2. Se o usuário pedir para **criar, atualizar ou excluir** um investimento ou meta, responda **APENAS com um JSON válido** no seguinte formato:
   - Para criar investimento: {"acao": "criar_investimento", "tipo": "CDB/CDI", "nome": "Nome do investimento", "valorAportado": 1000, "quantidade": 1, "precoUnitario": 1000}
   - Para criar meta: {"acao": "criar_meta", "nome": "Casa própria", "valorObjetivo": 500000, "prazoAnos": 10, "taxaAnual": 10}
   - Para listar investimentos/metas: {"acao": "listar_investimentos"} ou {"acao": "listar_metas"}
   - Para deletar: {"acao": "deletar_investimento", "id": "id_do_investimento"} ou {"acao": "deletar_meta", "id": "id_da_meta"}
   - Para obter planejamento baseado em gastos: {"acao": "planejamento"}
   - Para registrar um aporte: {"acao": "registrar_aporte", "valor": 500, "investimentoId": "id_do_investimento (opcional)", "descricao": "Aporte mensal"}
   - Para listar aportes: {"acao": "listar_aportes"}
   - Para ver o progresso de uma meta: {"acao": "progresso_meta", "metaId": "id_da_meta"}
   - Para sugerir alocação para uma meta: {"acao": "sugerir_alocacao", "metaId": "id_da_meta", "perfil": "moderado (opcional)"}
3. Se a conversa for genérica, responda normalmente.
4. **NUNCA** inclua texto fora do JSON quando for executar uma ação.
5. Se não souber o que fazer, pergunte educadamente.

Descrição Mais Completa:
1. REGISTRO DE TRANSAÇÕES (gastos/receitas)
   - Por texto: "gastei 50 no mercado", "recebi 2000 de salário"
   - Por áudio: envia áudio, Sora transcreve com Whisper e interpreta
   - Por imagem (nota fiscal): tira foto, usa Google Cloud Vision para ler valor e estabelecimento; funcionalidade disponível apenas nos planos Premium e Black.
   - Por importação OFX – também apenas Premium/Black.

2. CONTAS BANCÁRIAS (wallets)
   - Tipos: Corrente, Crédito, Poupança, Vale Alimentação, Dinheiro.
   - Comandos: "nubank 1000" (cria conta com saldo), "adicionar 200 no inter", "mude meu saldo do nubank pra 2000", "saldo" (lista todas as contas), "transferir 200 do nubank pro inter".
   - Limite de 3 contas por grupo no básico e contas ilimitadas no plano premium e black.

3. CATEGORIAS
   - Categorias padrão: Mercado, Transporte, Lazer e Entretenimento, Saúde, Aluguel, Educação, Casa, Salário, Alimentação, Recebimento, Transferências, Internet, Pet, Padaria, Assinaturas, Vestuário, Impostos, Viagem, Doações, Outros.
   - Usuário pode criar categorias e subcategorias personalizadas via painel web.
   - Subcategorias pré-definidas: Assinaturas (Netflix, HBO Max, Disney+, Globo Play, Prime Video, IPTV, Spotify), Vestuário (Shein, Adidas, Nike), Alimentação (Fastfood), Casa (conta de luz, água, gás), Lazer (Festas), Transferências (PIX, TED, DOC, Boleto, Transferência entre contas).

4. LIMITES DE GASTOS
   - Definir limite mensal por categoria: "limite mercado 500"
   - Definir limite geral mensal: "limite 2000"
   - Alertas de limite ao atingir 80%, 95% e 100% (via WhatsApp).

5. PARCELAS E RECORRÊNCIAS
   - Compras parceladas: "comprei [desc] no [cartão] em 3x de 140" (exclusivo para contas crédito).
   - Pagar parcela: "pagar parcela da [desc]" (irá orientar a transferência).
   - Contas fixas recorrentes: "todo mês 1000 aluguel dia 5" – registra automaticamente todo mês.

6. LEMBRETES
   - "lembrar pagar conta luz dia 10/05 valor 150" – envia alerta 2 dias antes e no vencimento.

7. INVESTIMENTOS (exclusivo plano Black)
   - Tipos de ativo: Tesouro Direto, CDB/CDI, Ações, FIIs, ETFs, Cripto, Previdência, Reserva de Emergência, Imóveis, Negócios próprios, Caixa.
   - Comandos: "criar investimento de R$ 1000 em CDB", "listar investimentos", "deletar investimento [id]".
   - Aportes: "registrar aporte de R$ 500 no CDB" (atualiza valor investido e atual). "listar aportes".
   - Evolução patrimonial, rentabilidade, distribuição da carteira (gráficos no painel).
   - Metas financeiras: "criar meta de R$ 50000 em 2 anos" – calcula aporte mensal necessário. "progresso meta [id]".
   - Sugestão de alocação: "sugerir alocacao para meta [id] com perfil [conservador/moderado/agressivo]".

8. GRUPOS E GESTÃO COMPARTILHADA
   - Cada usuário pertence a um grupo. Por padrão, grupo pessoal é criado automaticamente.
   - Comandos: "criar grupo Nome", "convidar grupo" (gera código), "entrar grupo CODIGO", "meus grupos", "trocar grupo Nome", "membros", "remover membro Nome".
   - Permissões: admin (dono), escrita (pode adicionar transações), leitura (apenas visualiza).
   - Limite de membros conforme plano do dono: Básico = 1, Premium = 3, Black = 5.

9. PLANOS E ACESSO (baseado em assinatura Stripe)
   - Básico: lançamentos ilimitados, até 3 contas bancárias, relatórios essenciais, lembretes de contas, Criação de categorias e subcategorias personalizadas, Controle de gastos via WhatsApp por texto e áudio, Gestão individual, Sistema web com gráficos interativos e gestão financeira, Alerta de limite de gastos, Limites de gastos por categoria, subcategoria e geral.
   - Premium: Todas as funções do Básico, inclui contas e cartões ilimitados, dicas de economia, gestão compartilhada com suporte de até 3 membros, Metas compartilhadas (ex.: viagem), envio de notas fiscais, importação OFX, relatórios avançados, suporte prioritário,
   - Black: tudo do Premium + central de investimentos completa (metas, aportes, projeções, gráficos, sugestão de alocação) + até 5 membros na gestão compartilhada com 1 usuário incluso sem custo adicional.
   - Usuários sem plano ativo têm plano = 'inativo' e não podem usar funcionalidades pagas.

10. PAINEL WEB
    - Acessível via https://totalyfe.online
    - Requer autenticação (Supabase) e vínculo do número do WhatsApp.
    - Exibe gráficos, permite gerenciar contas, categorias, limites, investimentos, metas, etc.

11. EXEMPLOS DE COMANDOS RÁPIDOS (reconhecidos por regex)
    - "gastei 50 no mercado" → registra despesa.
    - "recebi 2000 de salário" → registra receita.
    - "nubank 1000" → cria conta Nubank com saldo 1000.
    - "saldo" → lista todas as contas.
    - "transferir 200 do nubank pro inter" → transfere.
    - "limite 2000" → define limite de gastos.
    - "limite mercado 500" → define limite mensal para mercado.
    - "resumo" → mostra gastos por categoria do mês.
    - "analisar" → análise simples dos últimos 7 dias (dica curta).
    - "deletar conta nubank" → remove conta.
    - "excluir transação ABC12" → remove transação pelo ID.

12. TECNOLOGIAS E INTEGRAÇÕES
    - WhatsApp via Z-API.
    - OpenAI (GPT-4o-mini para interpretação e conversação; Whisper para áudio).
    - Google Cloud Vision para OCR de notas fiscais.
    - MongoDB para dados.
    - Supabase para autenticação e perfis.
    - Stripe para assinaturas.

**Instruções de resposta:**
1. Se o usuário pedir para **criar, alterar, listar, excluir** algo (investimentos, metas, transações, limites, etc.), responda **APENAS com um JSON** no formato das ações já definidas (criar_investimento, criar_meta, listar_investimentos, etc.).
2. Se o usuário pedir **dicas financeiras** (ex: "me dê dicas para economizar", "como posso gastar menos?", "dicas"), você deve **simular** que está analisando os dados do grupo e gerar recomendações realistas com base nos valores fornecidos (saldo, gastos, etc.). Use os dados atuais para ser específico.
   - Por exemplo, se o gasto com "Mercado" for alto, sugira comprar em atacado, evitar desperdícios.
   - Se "Assinaturas" for significativo, sugere cancelar as não utilizadas.
3. Se o usuário fizer uma **pergunta sobre o funcionamento do bot** (ex: "como registro um gasto?"), responda normalmente.
4. Para **conversa genérica** (oi, obrigado), responda de forma amigável.
5. **NUNCA** invente ações que não existem.
6. Sempre priorize a utilidade e a objetividade

Qualquer dúvida sobre como usar o bot ou sobre seus recursos, responda de forma clara e útil.

Agora, responda de acordo com a mensagem do usuário.`;

      const response = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.2
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

      let aiReply = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
      try {
        data = JSON.parse(aiReply);
      } catch (e) {
        console.log("Erro parse IA:", aiReply);
        await sendZap(phone, aiReply);
        return;
      }

      // ⭐ NOVO TRATAMENTO PARA RESPOSTA CONVERSACIONAL
if (data.acao === "conversa") {
  await sendZap(phone, data.resposta);
  return;
}
// Se não for conversa, continua para as ações normais (criar_grupo, salvar, etc.)

    }

    const nomesOficiais = { 
      "ITAU": "Itaú", "NUBANK": "Nubank", "NUBANK CREDITO": "Nubank Crédito",
      "INTER CREDITO": "Inter Crédito", "SANTANDER": "Santander", "BRADESCO": "Bradesco",
      "ITAU CREDITO": "Itaú Crédito", "BRADESCO CREDITO": "Bradesco Crédito",
      "SANTANDER CREDITO": "Santander Crédito", "INTER": "Inter", "PIX": "Dinheiro",
      "C6BANK": "C6 Bank", "C6 BANK": "C6 Bank", "C6 BANK CREDITO": "C6 Bank Crédito",
      "C6BANK CREDITO": "C6 Bank Crédito", "MERCADO PAGO": "Mercado Pago",
      "MERCADO PAGO CREDITO": "Mercado Pago Crédito", "PICPAY": "Picpay",
      "PICPAY CREDITO": "Picpay Crédito", "BANCO DO BRASIL": "Banco do Brasil",
      "BANCO DO BRASIL CREDITO": "Banco do Brasil Crédito", "CAIXA": "Caixa",
      "SAFRA": "Safra", "SAFRA CREDITO": "Safra Crédito",
    };

    // --- AÇÕES ---
    // Ações de grupo
    if (data.acao === "criar_grupo") {
      const nomeGrupo = data.nome;
      const existente = await Grupo.findOne({ donoId: user._id, nome: nomeGrupo });
      if (existente) {
        await sendZap(phone, `❌ Você já possui um grupo com o nome "${nomeGrupo}".`);
        return;
      }
      const novoGrupo = await Grupo.create({
        nome: nomeGrupo,
        donoId: user._id,
        membros: [{ userId: user._id, papel: "admin" }],
        codigoConvite: null
      });
      user.grupoAtivo = novoGrupo._id;
      await user.save();
      await sendZap(phone, `✅ Grupo "${nomeGrupo}" criado com sucesso! Você é o administrador. Use "convidar grupo" para gerar um código de convite.`);
    }
    else if (data.acao === "convidar_grupo") {
      const grupo = await Grupo.findById(grupoAtual._id);
      if (!grupo) return sendZap(phone, "Grupo não encontrado.");
      if (grupo.donoId.toString() !== user._id.toString()) {
        await sendZap(phone, "❌ Apenas o administrador do grupo pode gerar códigos de convite.");
        return;
      }
      const codigo = nanoid(6).toUpperCase();
      await Convite.create({
        grupoId: grupo._id,
        codigo,
        criadoPor: user._id,
        expiraEm: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
      await sendZap(phone, `🔑 Código de convite para o grupo "${grupo.nome}": *${codigo}*\nEnvie este código para quem deseja entrar. Válido por 7 dias.`);
    }
    else if (data.acao === "entrar_grupo") {
      const codigo = data.codigo;
      const convite = await Convite.findOne({ codigo, usado: false, expiraEm: { $gt: new Date() } });
      if (!convite) {
        await sendZap(phone, "❌ Código inválido ou expirado.");
        return;
      }
      const grupo = await Grupo.findById(convite.grupoId);
      if (!grupo) {
        await sendZap(phone, "Grupo não encontrado.");
        return;
      }
      const dono = await User.findById(grupo.donoId);
      if (!dono) {
        await sendZap(phone, "Erro: dono do grupo não encontrado.");
        return;
      }
      // Verificar limite de membros baseado no plano do dono
      const membrosAtuais = grupo.membros.length;
      let maxMembros = 1;
      if (dono.plano === 'premium') maxMembros = 3;
      else if (dono.plano === 'black') maxMembros = 5;
      else maxMembros = 1; // básico ou inativo
      if (membrosAtuais >= maxMembros) {
        await sendZap(phone, `❌ O grupo atingiu o limite de ${maxMembros} membro(s). Peça ao administrador para fazer upgrade do plano.`);
        return;
      }
      // Verificar se usuário já está no grupo
      if (grupo.membros.some(m => m.userId.toString() === user._id.toString())) {
        await sendZap(phone, "Você já faz parte deste grupo.");
        return;
      }
      grupo.membros.push({ userId: user._id, papel: "escrita" });
      await grupo.save();
      convite.usado = true;
      await convite.save();
      user.grupoAtivo = grupo._id;
      await user.save();
      await sendZap(phone, `✅ Você entrou no grupo "${grupo.nome}". Agora todas as suas transações serão compartilhadas com o grupo. Use "trocar grupo" para alternar entre grupos.`);
    }
    else if (data.acao === "meus_grupos") {
      const gruposDoUser = await Grupo.find({ "membros.userId": user._id });
      if (gruposDoUser.length === 0) {
        await sendZap(phone, "Você não participa de nenhum grupo. Crie um com 'criar grupo Nome'.");
      } else {
        let msg = "📋 *Seus grupos:*\n\n";
        for (const g of gruposDoUser) {
          const ativo = (user.grupoAtivo && user.grupoAtivo.toString() === g._id.toString()) ? " ✅ (ativo)" : "";
          msg += `- ${g.nome}${ativo}\n`;
        }
        msg += "\nPara trocar, use 'trocar grupo Nome'.";
        await sendZap(phone, msg);
      }
    }
    else if (data.acao === "trocar_grupo") {
      const nomeGrupo = data.nome;
      const grupo = await Grupo.findOne({ nome: nomeGrupo, "membros.userId": user._id });
      if (!grupo) {
        await sendZap(phone, `Grupo "${nomeGrupo}" não encontrado ou você não faz parte dele.`);
        return;
      }
      user.grupoAtivo = grupo._id;
      await user.save();
      await sendZap(phone, `✅ Grupo ativo alterado para "${grupo.nome}".`);
    }
    else if (data.acao === "listar_membros") {
      const grupo = await Grupo.findById(grupoAtual._id).populate('membros.userId', 'name phone');
      if (!grupo) return sendZap(phone, "Grupo não encontrado.");
      let msg = `👥 *Membros do grupo "${grupo.nome}":*\n\n`;
      for (const m of grupo.membros) {
        const papel = m.papel === 'admin' ? '👑 Admin' : (m.papel === 'leitura' ? '👀 Leitura' : '✍️ Escrita');
        msg += `- ${m.userId.name} (${papel})\n`;
      }
      await sendZap(phone, msg);
    }
    else if (data.acao === "remover_membro") {
      const nomeMembro = data.nome;
      const grupo = await Grupo.findById(grupoAtual._id).populate('membros.userId', 'name');
      if (!grupo) return sendZap(phone, "Grupo não encontrado.");
      if (grupo.donoId.toString() !== user._id.toString()) {
        await sendZap(phone, "❌ Apenas o administrador pode remover membros.");
        return;
      }
      const membro = grupo.membros.find(m => m.userId.name.toLowerCase().includes(nomeMembro.toLowerCase()));
      if (!membro) {
        await sendZap(phone, `Membro "${nomeMembro}" não encontrado.`);
        return;
      }
      if (membro.userId._id.toString() === user._id.toString()) {
        await sendZap(phone, "Você não pode remover a si mesmo. Peça a outro admin.");
        return;
      }
      grupo.membros = grupo.membros.filter(m => m.userId._id.toString() !== membro.userId._id.toString());
      await grupo.save();
      await sendZap(phone, `🗑️ Membro "${membro.userId.name}" removido do grupo.`);
    }
    // Ações existentes (adaptadas para usar grupoId)
    else if (data.acao === "set_meta") {
      // meta é do grupo? A meta de gastos é do usuário? Vamos manter no User por enquanto (individual)
      user.metaMensal = data.valor;
      await user.save();
      await sendZap(phone, `🎯 Meta de gastos definida: *R$ ${data.valor.toFixed(2)}*.`);
    }
    else if (data.acao === "set_fatura_dia") {
      user.diaFechamentoFatura = data.dia;
      await user.save();
      await sendZap(phone, `📅 Dia de fechamento da fatura definido para o dia ${data.dia} de cada mês.`);
    }
    else if (data.acao === "deletar_conta") {
      const nomeConta = data.nome;
      const conta = await Wallet.findOne({ grupoId: grupoAtual._id, nome: { $regex: new RegExp(`^${nomeConta}$`, 'i') } });
      if (!conta) {
        await sendZap(phone, `❌ Conta "${nomeConta}" não encontrada.`);
      } else {
        await Wallet.deleteOne({ grupoId: grupoAtual._id, nome: conta.nome });
        await sendZap(phone, `🗑️ Conta *${conta.nome}* removida com sucesso.`);
      }
    }
    else if (data.acao === "compra_parcelada") {
      const { descricao, carteira, numParcelas, valorParcela, valorTotal, categoria } = data;
      let nomeCarteira = carteira.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
      const ehCredito = nomeCarteira.includes("CREDITO");
      if (!ehCredito) {
        await sendZap(phone, "⚠️ Compras parceladas só são permitidas em contas de crédito.");
        return;
      }
      let baseNome = nomeCarteira.replace("CREDITO", "").trim();
      let carteiraNome = nomesOficiais[baseNome] || baseNome;
      carteiraNome += " Crédito";

      let wallet = await Wallet.findOne({ grupoId: grupoAtual._id, nome: carteiraNome });
      if (!wallet) {
        await sendZap(phone, `❌ Conta ${carteiraNome} não encontrada. Crie-a primeiro com "nubank crédito 0".`);
        return;
      }
      if (wallet.saldo < valorTotal) {
        await sendZap(phone, `⚠️ Limite insuficiente na conta ${carteiraNome}. Disponível: R$ ${wallet.saldo.toFixed(2)}.`);
        return;
      }
      wallet.saldo -= valorTotal;
      await wallet.save();

      const dataPrimeiraVencimento = new Date();
      dataPrimeiraVencimento.setDate(dataPrimeiraVencimento.getDate() + 30);
      await Parcela.create({
        grupoId: grupoAtual._id,
        descricao, valorTotal, valorParcela, totalParcelas: numParcelas,
        parcelasPagas: 0, dataProximaVencimento: dataPrimeiraVencimento,
        categoria, carteira: carteiraNome, ativa: true
      });

      await sendZap(phone, `✅ *Compra parcelada registrada!*\n\n*${descricao}*\nTotal: R$ ${valorTotal.toFixed(2)} em ${numParcelas}x de R$ ${valorParcela.toFixed(2)}\nCarteira: ${carteiraNome}\nPrimeira parcela vence em ${dataPrimeiraVencimento.toLocaleDateString('pt-BR')}.\n\n⚠️ Lembre-se de pagar cada parcela mensalmente usando "pagar parcela ${descricao}".`);
    }
    else if (data.acao === "pagar_parcela") {
      const descricao = data.descricao;
      const parcela = await Parcela.findOne({ grupoId: grupoAtual._id, descricao: { $regex: new RegExp(descricao, 'i') }, ativa: true });
      if (!parcela) {
        await sendZap(phone, `❌ Não encontrei parcela pendente para "${descricao}".`);
        return;
      }
      if (parcela.parcelasPagas >= parcela.totalParcelas) {
        await sendZap(phone, `✅ Todas as parcelas de "${parcela.descricao}" já foram pagas.`);
        return;
      }
      const valorParcela = parcela.valorParcela;
      await sendZap(phone, `💳 Para pagar a parcela ${parcela.parcelasPagas+1}/${parcela.totalParcelas} de R$ ${valorParcela.toFixed(2)} da compra "${parcela.descricao}", transfira esse valor da sua conta débito para a conta ${parcela.carteira} usando:\n\n"transferir ${valorParcela.toFixed(2)} do [sua_conta] para ${parcela.carteira}"\n\nApós a transferência, me avise "parcela paga ${descricao}" para eu atualizar.`);
    }
    else if (data.acao === "confirmar_pagamento_parcela") {
  const descricao = data.descricao;
  
  // Buscar a parcela ativa
  const parcela = await Parcela.findOne({ 
    grupoId: grupoAtual._id, 
    descricao: { $regex: new RegExp(descricao, 'i') }, 
    ativa: true
  });
  
  if (!parcela) {
    await sendZap(phone, `❌ Não encontrei nenhuma parcela pendente para "${descricao}". Verifique o nome.`);
    return;
  }
  
  // Verificar se todas as parcelas já foram pagas
  if (parcela.parcelasPagas >= parcela.totalParcelas) {
    await sendZap(phone, `✅ A compra "${parcela.descricao}" já está totalmente quitada.`);
    return;
  }
  
  // Incrementar parcelas pagas
  parcela.parcelasPagas += 1;
  
  // Verificar se completou
  if (parcela.parcelasPagas >= parcela.totalParcelas) {
    parcela.ativa = false;
    await parcela.save();
    await sendZap(phone, `🎉 Parabéns! Você quitou todas as parcelas de "${parcela.descricao}". Obrigado por usar o Sora! 🎉`);
  } else {
    // Atualizar data da próxima vencimento para +30 dias
    const novaData = new Date();
    novaData.setDate(novaData.getDate() + 30);
    parcela.dataProximaVencimento = novaData;
    await parcela.save();
    await sendZap(phone, `✅ Parcela ${parcela.parcelasPagas}/${parcela.totalParcelas} da compra "${parcela.descricao}" foi confirmada como paga. Próxima parcela vence em ${novaData.toLocaleDateString('pt-BR')}.`);
  }
}
    else if (data.acao === "apagar") {
      let excluido;
      if (data.idCurto) {
        excluido = await Finance.findOneAndDelete({ grupoId: grupoAtual._id, idCurto: data.idCurto });
      } else {
        excluido = await Finance.findOneAndDelete({ grupoId: grupoAtual._id }, { sort: { data: -1 } });
      }
      if (excluido) {
        if (excluido.pago) {
          const carteiraNome = (excluido.observacao.match(/\[(.*?)\]/) || [])[1] || "DINHEIRO";
          const wallet = await Wallet.findOne({ grupoId: grupoAtual._id, nome: carteiraNome });
          const ehCredito = wallet?.tipo === "Crédito";
          let multiplicador = excluido.tipo === "Gasto" ? 1 : -1;
          if (ehCredito && excluido.tipo === "Gasto") multiplicador = 1;
          if (ehCredito && excluido.tipo === "Recebimento") multiplicador = -1;
          await Wallet.updateOne({ grupoId: grupoAtual._id, nome: carteiraNome }, { $inc: { saldo: excluido.valor * multiplicador } });
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
      await Recorrencia.create({ grupoId: grupoAtual._id, tipo: data.tipo || "Gasto", valor: valorLimpo, categoria: data.categoria, diaVencimento: data.dia, descricao: data.observacao, carteira: carteiraFinal });
      await sendZap(phone, `📌 *Agendado!* Todo dia ${data.dia} no *${carteiraFinal}*.`);
    }
        else if (data.acao === "cancelar_recorrencia") {
  const descricao = data.descricao;
  // Escapa caracteres especiais para uso em regex
  const escapedDesc = descricao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Busca recorrência ativa no grupo atual, ignorando maiúsculas/minúsculas
  const recorrencia = await Recorrencia.findOne({
    grupoId: grupoAtual._id,
    descricao: { $regex: new RegExp(`^${escapedDesc}$`, 'i') },
    ativa: true
  });
  if (!recorrencia) {
    await sendZap(phone, `❌ Não encontrei nenhuma recorrência ativa com a descrição "${descricao}".`);
    return;
  }
  recorrencia.ativa = false;
  await recorrencia.save();
  await sendZap(phone, `✅ Recorrência *"${recorrencia.descricao}"* cancelada. Você não será mais cobrado(a) automaticamente.`);
}
    else if (data.acao === "set_wallet") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      let nomeOriginal = data.nome.trim();
      let nomeNormalizado = nomeOriginal.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
      const ehCredito = nomeNormalizado.includes("CREDITO");
      let nomeBase = ehCredito ? nomeNormalizado.replace("CREDITO", "").trim() : nomeNormalizado;
      let nomeFinal = nomesOficiais[nomeBase];
      if (!nomeFinal) {
        await sendZap(phone, `⚠️ "${nomeOriginal}" não é um banco reconhecido. Use nomes como Nubank, Itaú, etc. Conta não criada.`);
        return;
      }
      if (ehCredito) nomeFinal += " Crédito";
      const count = await Wallet.countDocuments({ grupoId: grupoAtual._id });
      if (count >= 3 && !(await Wallet.findOne({ grupoId: grupoAtual._id, nome: nomeFinal }))) {
        await sendZap(phone, "⚠️ Limite de 3 contas bancárias atingido. Remova uma antes de adicionar outra.");
      } else {
        await Wallet.findOneAndUpdate(
          { grupoId: grupoAtual._id, nome: nomeFinal },
          { saldo: valorLimpo, tipo: ehCredito ? "Crédito" : "Corrente" },
          { upsert: true, new: true }
        );
        await sendZap(phone, `🏦 Conta *${nomeFinal}* configurada com R$ ${valorLimpo.toFixed(2)}.`);
      }
    }
    else if (data.acao === "ver_saldos") {
      const carteiras = await Wallet.find({ grupoId: grupoAtual._id, saldo: { $ne: 0 } });
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
      await Wallet.findOneAndUpdate({ grupoId: grupoAtual._id, nome: nomeOrigem }, { $inc: { saldo: -valorLimpo } });
      await Wallet.findOneAndUpdate({ grupoId: grupoAtual._id, nome: nomeDestino }, { $inc: { saldo: valorLimpo }, upsert: true });
      await Finance.create({ grupoId: grupoAtual._id, idCurto: nanoid(6), tipo: "Transferência", categoria: "Transferência", valor: valorLimpo, observacao: `Pix: ${nomeOrigem} ➔ ${nomeDestino}` });
      await sendZap(phone, `💸 *Transferência concluída!*\n\nSaída: *${nomeOrigem}*\nEntrada: *${nomeDestino}*\nValor: R$ ${valorLimpo.toFixed(2)}`);
      
      const contaDestino = await Wallet.findOne({ grupoId: grupoAtual._id, nome: nomeDestino });
      if (contaDestino && contaDestino.tipo === "Crédito") {
        const parcela = await Parcela.findOne({ grupoId: grupoAtual._id, carteira: nomeDestino, ativa: true, parcelasPagas: { $lt: "$totalParcelas" } }).sort({ dataProximaVencimento: 1 });
        if (parcela) {
          parcela.parcelasPagas += 1;
          if (parcela.parcelasPagas >= parcela.totalParcelas) {
            parcela.ativa = false;
            await sendZap(phone, `🎉 Parabéns! Você quitou todas as parcelas de "${parcela.descricao}".`);
          } else {
            const novaData = new Date();
            novaData.setDate(novaData.getDate() + 30);
            parcela.dataProximaVencimento = novaData;
            await sendZap(phone, `✅ Parcela ${parcela.parcelasPagas}/${parcela.totalParcelas} da compra "${parcela.descricao}" foi paga. Próxima parcela vence em ${novaData.toLocaleDateString('pt-BR')}.`);
          }
          await parcela.save();
        }
      }
    }
    else if (data.acao === "buscar") {
      const termo = data.termo;
      let filtro = { grupoId: grupoAtual._id, tipo: "Gasto" };
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
      const gastos = await Finance.find({ grupoId: grupoAtual._id, tipo: "Gasto", data: { $gte: umaSemanaAtras } });
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
        { grupoId: grupoAtual._id, categoria, mesReferencia: new Date().toISOString().slice(0,7) },
        { limiteMensal: limite },
        { upsert: true }
      );
      await sendZap(phone, `🔔 Limite para *${categoria}* definido como R$ ${limite.toFixed(2)} para este mês.`);
    }
    else if (data.acao === "meus_limites") {
      const limites = await CategoryLimit.find({ grupoId: grupoAtual._id, mesReferencia: new Date().toISOString().slice(0,7) });
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
        grupoId: grupoAtual._id,
        descricao: data.descricao, valor: data.valor, tipo: data.tipo,
        dataVencimento: dataVenc, diasAntecedencia: 2, enviado: false
      });
      await sendZap(phone, `🔔 Lembrete criado: ${data.tipo === "pagar" ? "🔴 Pagar" : "🟢 Receber"} *${data.descricao}* no valor de R$ ${data.valor.toFixed(2)} até ${dataVenc.toLocaleDateString('pt-BR')}.`);
    }

    // ========== AÇÕES DE INVESTIMENTOS (protegidas por plano Black) – adaptadas para grupoId ==========
    else if (data.acao === "criar_investimento") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de investimentos está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { tipo, nome, valorAportado, quantidade, precoUnitario, ticker, dataCompra } = data;
      const investimento = await Investimento.create({
        grupoId: grupoAtual._id,
        tipo, nome,
        ticker: ticker || null,
        quantidade: quantidade || 1, 
        precoUnitario: precoUnitario || valorAportado,
        valorAportado,
        dataCompra: dataCompra ? new Date(dataCompra) : new Date(),
        valorAtual: (quantidade || 1) * (precoUnitario || valorAportado),
        rentabilidade: 0
      });
      await sendZap(phone, `✅ Investimento "${investimento.nome}" (${investimento.tipo}) criado com valor aportado de R$ ${investimento.valorAportado.toFixed(2)}.`);
    }
    else if (data.acao === "criar_meta") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de metas financeiras está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { nome, valorObjetivo, prazoAnos, taxaAnual, investimentoId } = data;
      const jurosMensal = Math.pow(1 + (taxaAnual / 100), 1/12) - 1;
      const n = prazoAnos * 12;
      let aporteMensal = (valorObjetivo * jurosMensal) / (Math.pow(1 + jurosMensal, n) - 1);
      if (!isFinite(aporteMensal)) aporteMensal = valorObjetivo / n;
      const meta = await Meta.create({
        grupoId: grupoAtual._id,
        nome, valorObjetivo, prazoAnos, taxaAnual,
        aporteMensalSugerido: parseFloat(aporteMensal.toFixed(2)),
        investimentoId: investimentoId || null
      });
      await sendZap(phone, `🎯 Meta "${meta.nome}" criada! Para alcançar R$ ${meta.valorObjetivo} em ${meta.prazoAnos} anos, aporte R$ ${meta.aporteMensalSugerido}/mês (considerando ${taxaAnual}% a.a.).`);
    }
    else if (data.acao === "listar_investimentos") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de investimentos está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const invs = await Investimento.find({ grupoId: grupoAtual._id });
      if (invs.length === 0) {
        await sendZap(phone, "Você ainda não tem nenhum investimento cadastrado. Diga 'criar investimento' para começar.");
      } else {
        let totalInv = 0, totalAtual = 0, totalDividendos = 0;
const agrupado = {};
let msg = "📈 *SEUS INVESTIMENTOS (com dividendos):*\n\n";

for (const i of invs) {
  totalInv += i.valorAportado;
  totalAtual += i.valorAtual;
  totalDividendos += i.dividendosAcumulados || 0;
  // rentabilidade já armazenada em decimal (ex: 0.15 = 15%)
  const rentabilidadeReal = (i.rentabilidade || 0) * 100;
  
  msg += `💰 *${i.nome}* (${i.tipo})\n`;
  msg += `   Aportado: R$ ${i.valorAportado.toFixed(2)}\n`;
  msg += `   Atual: R$ ${i.valorAtual.toFixed(2)}\n`;
  msg += `   Dividendos: R$ ${(i.dividendosAcumulados || 0).toFixed(2)}\n`;
  msg += `   Rentabilidade total: ${rentabilidadeReal.toFixed(2)}% (valorização + proventos)\n\n`;
  
  const tipo = i.tipo;
  agrupado[tipo] = (agrupado[tipo] || 0) + (i.valorAtual + (i.dividendosAcumulados || 0));
}

const valorPatrimonioComDividendos = totalAtual + totalDividendos;
const rentabilidadeGeral = totalInv > 0 ? ((valorPatrimonioComDividendos - totalInv) / totalInv) * 100 : 0;

msg += `*RESUMO DA CARTEIRA:*\n`;
msg += `💵 Total aportado: R$ ${totalInv.toFixed(2)}\n`;
msg += `📊 Valor atual (sem dividendos): R$ ${totalAtual.toFixed(2)}\n`;
msg += `💰 Dividendos recebidos: R$ ${totalDividendos.toFixed(2)}\n`;
msg += `📈 Patrimônio total (atual + dividendos): R$ ${valorPatrimonioComDividendos.toFixed(2)}\n`;
msg += `🎯 Rentabilidade geral (com proventos): ${rentabilidadeGeral.toFixed(2)}%\n\n`;

msg += "📊 *DISTRIBUIÇÃO POR TIPO (patrimônio total)*:\n";
for (const [tipo, valor] of Object.entries(agrupado)) {
  const percentual = (valor / valorPatrimonioComDividendos) * 100;
  msg += `${tipo}: R$ ${valor.toFixed(2)} (${percentual.toFixed(1)}%)\n`;
}

await sendZap(phone, msg);
    }
  }
    else if (data.acao === "listar_metas") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de metas financeiras está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const metasList = await Meta.find({ grupoId: grupoAtual._id });
      if (metasList.length === 0) {
        await sendZap(phone, "Nenhuma meta cadastrada. Diga 'criar meta' para definir uma.");
      } else {
        let msg = "🎯 *SUAS METAS FINANCEIRAS:*\n\n";
        for (const m of metasList) {
          msg += `*${m.nome}*: R$ ${m.valorObjetivo} em ${m.prazoAnos} anos\nAporte mensal sugerido: R$ ${m.aporteMensalSugerido}\nStatus: ${m.status}\n\n`;
        }
        await sendZap(phone, msg);
      }
    }
    else if (data.acao === "planejamento") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de planejamento de investimentos está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const umAnoAtras = new Date(); umAnoAtras.setFullYear(umAnoAtras.getFullYear() - 1);
      const transacoes = await Finance.find({ grupoId: grupoAtual._id, data: { $gte: umAnoAtras } });
      let receitas = 0, despesas = 0;
      transacoes.forEach(t => {
        if (t.tipo === "Recebimento") receitas += t.valor;
        else if (t.tipo === "Gasto") despesas += t.valor;
      });
      const sobraMedia = (receitas - despesas) / 12;
      await sendZap(phone, `📊 *PLANEJAMENTO SUGERIDO*\n\nCom base nos seus gastos dos últimos 12 meses, sua sobra média mensal é de *R$ ${sobraMedia.toFixed(2)}*.\n\n💡 Você pode investir esse valor para alcançar metas mais rápido. Quer criar uma meta com esse aporte? Diga 'sim' ou 'criar meta'.`);
    }
    else if (data.acao === "deletar_investimento") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de investimentos está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { id } = data;
      const result = await Investimento.findByIdAndDelete(id);
      if (result) await sendZap(phone, `🗑️ Investimento "${result.nome}" removido.`);
      else await sendZap(phone, "Investimento não encontrado.");
    }
    else if (data.acao === "deletar_meta") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de metas financeiras está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { id } = data;
      const result = await Meta.findByIdAndDelete(id);
      if (result) await sendZap(phone, `🗑️ Meta "${result.nome}" removida.`);
      else await sendZap(phone, "Meta não encontrada.");
    }
    else if (data.acao === "registrar_aporte") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de aportes está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { valor, investimentoId, descricao } = data;
      if (!valor || valor <= 0) {
        await sendZap(phone, "❌ Valor do aporte inválido.");
        return;
      }
      const aporte = await Aporte.create({
        grupoId: grupoAtual._id,
        valor,
        investimentoId: investimentoId || null,
        descricao: descricao || "Aporte realizado",
        data: new Date()
      });
      if (investimentoId) {
        const inv = await Investimento.findById(investimentoId);
        if (inv) {
          const novoValorAportado = inv.valorAportado + valor;
          const novoValorAtual = inv.valorAtual + valor;
          await Investimento.findByIdAndUpdate(investimentoId, {
            valorAportado: novoValorAportado,
            valorAtual: novoValorAtual
          });
          await sendZap(phone, `💰 Aporte de R$ ${valor.toFixed(2)} registrado para o investimento "${inv.nome}". Saldo atualizado: R$ ${novoValorAtual.toFixed(2)}.`);
        } else {
          await sendZap(phone, `💰 Aporte de R$ ${valor.toFixed(2)} registrado (investimento não encontrado, mas o aporte foi salvo).`);
        }
      } else {
        await sendZap(phone, `💰 Aporte de R$ ${valor.toFixed(2)} registrado com sucesso.`);
      }
      if (investimentoId) {
        const metasAssociadas = await Meta.find({ grupoId: grupoAtual._id, investimentoId });
        for (const meta of metasAssociadas) {
          const totalAportado = await Aporte.aggregate([
            { $match: { grupoId: grupoAtual._id, investimentoId } },
            { $group: { _id: null, total: { $sum: "$valor" } } }
          ]);
          const aportado = totalAportado[0]?.total || 0;
          if (aportado >= meta.valorObjetivo) {
            meta.status = "concluída";
            await meta.save();
            await sendZap(phone, `🎉 Parabéns! Você atingiu sua meta "${meta.nome}"! 🎉`);
          }
        }
      }
    }
    else if (data.acao === "listar_aportes") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de aportes está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const aportes = await Aporte.find({ grupoId: grupoAtual._id }).sort({ data: -1 }).limit(10);
      if (aportes.length === 0) {
        await sendZap(phone, "Nenhum aporte registrado ainda. Use 'registrar aporte' para começar.");
      } else {
        let msg = "📊 *HISTÓRICO DE APORTES (últimos 10):*\n\n";
        for (const ap of aportes) {
          const dataStr = new Date(ap.data).toLocaleDateString('pt-BR');
          const invInfo = ap.investimentoId ? ` (Investimento ID: ${ap.investimentoId})` : "";
          msg += `📅 ${dataStr}: R$ ${ap.valor.toFixed(2)}${invInfo} - ${ap.descricao}\n`;
        }
        await sendZap(phone, msg);
      }
    }

    else if (data.acao === "progresso_meta") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de progresso de metas está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { metaId } = data;
      const meta = await Meta.findOne({ grupoId: grupoAtual._id, _id: metaId });
      if (!meta) {
        await sendZap(phone, "Meta não encontrada.");
        return;
      }
      let totalAportado = 0;
      if (meta.investimentoId) {
        const aportes = await Aporte.aggregate([
          { $match: { grupoId: grupoAtual._id, investimentoId: meta.investimentoId } },
          { $group: { _id: null, total: { $sum: "$valor" } } }
        ]);
        totalAportado = aportes[0]?.total || 0;
      } else {
        const aportes = await Aporte.aggregate([
          { $match: { grupoId: grupoAtual._id } },
          { $group: { _id: null, total: { $sum: "$valor" } } }
        ]);
        totalAportado = aportes[0]?.total || 0;
      }
      const faltante = meta.valorObjetivo - totalAportado;
      const mesesRestantes = Math.ceil(faltante / meta.aporteMensalSugerido);
      const anosRestantes = (mesesRestantes / 12).toFixed(1);
      const percentual = (totalAportado / meta.valorObjetivo) * 100;
      let statusEmoji = "⏳";
      if (percentual >= 100) statusEmoji = "✅";
      else if (percentual >= 75) statusEmoji = "📈";
      await sendZap(phone, `🎯 *Progresso da meta "${meta.nome}"*\n\n💰 Objetivo: R$ ${meta.valorObjetivo}\n✅ Já aportado: R$ ${totalAportado.toFixed(2)} (${percentual.toFixed(1)}%)\n📉 Faltam: R$ ${faltante.toFixed(2)}\n⏱️ Aporte mensal sugerido: R$ ${meta.aporteMensalSugerido}\n📅 Tempo estimado restante: ${mesesRestantes} meses (${anosRestantes} anos)\n${statusEmoji} Status: ${meta.status}`);
    }

    else if (data.acao === "sugerir_alocacao") {
      const isBlack = await verificarPlanoInvestimentos(phone);
      if (!isBlack) {
        await sendZap(phone, "🚫 A funcionalidade de sugestão de alocação está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
        return;
      }
      const { metaId, perfil } = data;
      const meta = await Meta.findOne({ grupoId: grupoAtual._id, _id: metaId });
      if (!meta) {
        await sendZap(phone, "Meta não encontrada.");
        return;
      }
      const perfilUsuario = perfil || "moderado";
      let sugestao = "";
      if (meta.prazoAnos <= 3) {
        sugestao = "💰 *Para prazos curtos (até 3 anos), recomendo:*\n- 80% em Renda Fixa (Tesouro Selic, CDB pós-fixado)\n- 20% em Fundos DI ou poupança.\nEvite renda variável devido ao risco.";
      } else if (meta.prazoAnos <= 7) {
        sugestao = "📈 *Para prazos médios (4-7 anos):*\n- 60% Renda Fixa (Tesouro IPCA+, CDB)\n- 30% Renda Variável (Ações de boas empresas, FIIs)\n- 10% Reserva de liquidez (Tesouro Selic).";
      } else {
        sugestao = "🚀 *Para prazos longos (>7 anos):*\n- 40% Renda Fixa (Tesouro IPCA+)\n- 50% Renda Variável (Ações, ETFs, FIIs)\n- 10% Reserva de emergência.\nConsidere também exposição internacional (IVVB11).";
      }
      if (perfilUsuario === "conservador") {
        sugestao = "🛡️ *Perfil Conservador:* " + sugestao.replace(/\d+%/, "90% na primeira categoria, 10% na segunda");
      } else if (perfilUsuario === "agressivo") {
        sugestao = "⚡ *Perfil Agressivo:* " + sugestao.replace(/\d+%/, "inverta os percentuais, com foco em ações e ETFs");
      }
      await sendZap(phone, `📊 *Sugestão de alocação para a meta "${meta.nome}"*\n\n${sugestao}\n\nLembre-se de ajustar conforme seu apetite ao risco. Consulte um especialista antes de investir.`);
    }

    else if (data.acao === "gerar_dicas") {
  const isBlack = await verificarPlanoInvestimentos(phone);
  if (!isBlack) {
    await sendZap(phone, "🚫 A funcionalidade de dicas personalizadas está disponível apenas no plano Black. Faça upgrade pelo nosso painel.");
    return;
  }
  const grupoId = await getGrupoFromPhone(phone);
  if (!grupoId) {
    await sendZap(phone, "Você não está vinculado a nenhum grupo. Use 'criar grupo' ou entre em um grupo primeiro.");
    return;
  }
  const dicas = await gerarDicasFinanceiras(grupoId, phone);
  await sendZap(phone, dicas);
}

else if (data.acao === "ver_dividendos") {
  const invs = await Investimento.find({ grupoId: grupoAtual._id, dividendosAcumulados: { $gt: 0 } });
  if (invs.length === 0) {
    await sendZap(phone, "📭 Você ainda não recebeu dividendos (ou nenhum investimento com ticker cadastrado).");
    return;
  }
  let msg = "💰 *DIVIDENDOS RECEBIDOS (histórico)*\n\n";
  let total = 0;
  for (const inv of invs) {
    msg += `📌 ${inv.nome} (${inv.ticker}): R$ ${(inv.dividendosAcumulados || 0).toFixed(2)}\n`;
    total += inv.dividendosAcumulados || 0;
  }
  msg += `\n💵 *Total de proventos: R$ ${total.toFixed(2)}*`;
  await sendZap(phone, msg);
}

    else if (data.acao === "salvar") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      let carteiraNormalizada = data.carteira ? data.carteira.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim() : "";
      const ehCredito = carteiraNormalizada.includes("CREDITO");
      let nomeEntrada = data.carteira ? data.carteira.toUpperCase().trim() : "DINHEIRO";
      
      let carteiraNome;
      if (carteiraNormalizada && nomesOficiais[carteiraNormalizada]) {
        carteiraNome = nomesOficiais[carteiraNormalizada];
      } else if (carteiraNormalizada && nomesOficiais[carteiraNormalizada.replace("CREDITO", "").trim()]) {
        let base = carteiraNormalizada.replace("CREDITO", "").trim();
        carteiraNome = nomesOficiais[base] + (ehCredito ? " Crédito" : "");
      } else {
        carteiraNome = "Dinheiro";
      }
      
      const walletExists = await Wallet.findOne({ grupoId: grupoAtual._id, nome: carteiraNome });
      if (!walletExists && carteiraNome !== "Dinheiro") {
        const count = await Wallet.countDocuments({ grupoId: grupoAtual._id });
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

      await Finance.create({ grupoId: grupoAtual._id, idCurto: idTransacao, tipo: data.tipo, categoria: data.categoria, valor: valorLimpo, observacao: `${data.observacao || ''} [${carteiraNome}]`, pago: isPago, recorrente: data.recorrente, vencimento: dataVenc });

      if (isPago) {
        const multiplicador = (data.tipo === "Gasto" ? -1 : 1);
        await Wallet.findOneAndUpdate(
          { grupoId: grupoAtual._id, nome: carteiraNome },
          { $inc: { saldo: valorLimpo * multiplicador }, $set: { tipo: ehCredito ? "Crédito" : "Corrente" } },
          { upsert: true }
        );
      }

      if (data.tipo === "Gasto") {
        await verificarLimiteCategoria(grupoAtual._id, data.categoria, valorLimpo, phone);
      }

      if (data.tipo === "Recebimento") {
        await atualizarRendaMedia(grupoAtual._id);
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
        { $match: { grupoId: grupoAtual._id, tipo: "Gasto", data: { $gte: inicioMes } } },
        { $group: { _id: "$categoria", total: { $sum: "$valor" } } },
        { $sort: { total: -1 } }
      ]);
      const todos = await Finance.find({ grupoId: grupoAtual._id, data: { $gte: inicioMes } });
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

// --- ROTAS DA API (adaptadas para grupoId via phone do usuário) ---
function authMiddleware(req, res, next) {
  const token = req.query.token || req.headers['x-api-token'];
  if (!API_SECRET_TOKEN || token === API_SECRET_TOKEN) return next();
  res.status(401).json({ erro: "Não autorizado" });
}

// Middleware para verificar plano Black nas rotas de investimento
async function checkInvestimentosPlan(req, res, next) {
  let phone = req.params.phone || req.body.phone || req.query.phone;
  if (!phone) return res.status(400).json({ erro: "phone não fornecido" });
  phone = normalizarPhone(phone);
  const user = await User.findOne({ phone });
  if (user && user.plano === 'black') return next();
  res.status(403).json({ erro: "Plano Black necessário para acessar investimentos" });
}

// Helper para obter grupoId a partir do phone (cria usuário/grupo se não existir)
async function getGrupoFromPhone(phone) {
  const rawPhone = normalizarPhone(phone);
  
  let user = await User.findOne({ phone: rawPhone });
  if (!user) {
    // Cria usuário automaticamente se não existir
    user = await User.create({ phone: rawPhone, name: "Usuário do Painel" });
    console.log(`✅ Usuário ${rawPhone} criado automaticamente pelo getGrupoFromPhone.`);
  }
  
  if (!user.grupoAtivo) {
    try {
      const grupo = await Grupo.create({
        nome: "Pessoal",
        donoId: user._id,
        membros: [{ userId: user._id, papel: "admin" }],
        codigoConvite: null
      });
      user.grupoAtivo = grupo._id;
      await user.save();
      
      // Migrar dados antigos (se houver transações com phone, sem grupoId)
      await Wallet.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Finance.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Recorrencia.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await CategoryLimit.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Reminder.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Parcela.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Categoria.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Investimento.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Aporte.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await Meta.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await HistoricoInvestimento.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      await PatrimonioHistorico.updateMany({ phone: rawPhone }, { grupoId: grupo._id });
      
      await criarCategoriasPadrao(grupo._id);
      console.log(`✅ Grupo criado para usuário ${rawPhone}`);
    } catch (err) {
      console.error(`❌ Erro ao criar grupo para ${rawPhone}:`, err);
      throw new Error("Falha ao criar grupo");
    }
  }
  
  return user.grupoAtivo;
}

// Rota para sincronizar plano e dados do usuário a partir do Stripe
app.post("/api/user/update-plan", authMiddleware, async (req, res) => {
  try {
    const { phone, email, plano, intervalo, validoAte } = req.body;
    if (!phone) {
      return res.status(400).json({ erro: "phone é obrigatório" });
    }

    const user = await User.findOneAndUpdate(
      { phone },
      { email, plano, intervalo, validoAte: validoAte ? new Date(validoAte) : null },
      { upsert: true, returnDocument: 'after' }
    );

    // Se o plano for alterado e o usuário for dono de algum grupo, revalidar limites (opcional)
    // Por simplicidade, não implementamos aqui.

    try {
      const grupoId = await getGrupoFromPhone(phone);
      if (grupoId) await criarCategoriasPadrao(grupoId);
    } catch (err) {
      console.error(`⚠️ Erro ao criar categorias padrão para ${phone}:`, err);
    }

    console.log(`✅ Usuário ${phone} atualizado: plano ${plano}, intervalo ${intervalo}`);
    res.json({ ok: true, user });
  } catch (err) {
    console.error("Erro ao atualizar plano do usuário:", err);
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/transacoes/:phone", authMiddleware, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const transacoes = await Finance.find({ grupoId }).sort({ data: -1 });
    res.json(transacoes);
  } catch (error) {
    res.status(500).json({ erro: "Erro ao buscar dados" });
  }
});

app.post("/api/importar-ofx", authMiddleware, async (req, res) => {
  res.json({ msg: "Funcionalidade OFX em breve" });
});

// ================= ROTAS DE GRUPOS (GESTÃO COMPARTILHADA) =================

// Criar um novo grupo (via painel)
app.post("/api/criar-grupo", authMiddleware, async (req, res) => {
  try {
    let { phone, nome } = req.body;
    if (!phone || !nome) {
      return res.status(400).json({ erro: "phone e nome são obrigatórios" });
    }

    // Normaliza o telefone
    const rawPhone = normalizarPhone(phone);
    let user = await User.findOne({ phone: rawPhone });
    if (!user) {
      return res.status(404).json({ erro: "Usuário não encontrado. Ele precisa ter interagido com o bot antes." });
    }

    // Verifica se já existe um grupo com esse nome para o mesmo dono
    const existente = await Grupo.findOne({ donoId: user._id, nome });
    if (existente) {
      return res.status(400).json({ erro: `Você já possui um grupo com o nome "${nome}".` });
    }

    const novoGrupo = await Grupo.create({
      nome,
      donoId: user._id,
      membros: [{ userId: user._id, papel: "admin" }],
      codigoConvite: null
    });

    // Opcional: definir este como grupo ativo
    user.grupoAtivo = novoGrupo._id;
    await user.save();

    // Criar categorias padrão para o novo grupo
    await criarCategoriasPadrao(novoGrupo._id);

    res.json({ ok: true, grupo: novoGrupo });
  } catch (err) {
    console.error("Erro ao criar grupo:", err);
    res.status(500).json({ erro: err.message });
  }
});

// ================= NOVAS ROTAS PARA O PAINEL LOVABLE =================

// --- CONTAS BANCÁRIAS (WALLETS) ---
app.get("/api/wallets/:phone", authMiddleware, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const wallets = await Wallet.find({ grupoId });
    res.json(wallets);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/wallets", authMiddleware, async (req, res) => {
  try {
    const { phone, nome, tipo, saldo, limite } = req.body;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const count = await Wallet.countDocuments({ grupoId });
    if (count >= 3 && !(await Wallet.findOne({ grupoId, nome }))) {
      return res.status(400).json({ erro: "Limite de 3 contas atingido" });
    }
    const wallet = await Wallet.findOneAndUpdate(
      { grupoId, nome },
      { tipo, saldo, limite },
      { upsert: true, new: true }
    );
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete("/api/wallets/:phone/:nome", authMiddleware, async (req, res) => {
  try {
    const { phone, nome } = req.params;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const result = await Wallet.deleteOne({ grupoId, nome: decodeURIComponent(nome) });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// --- CATEGORIAS PERSONALIZADAS ---
app.get("/api/categorias/:phone", authMiddleware, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const categorias = await Categoria.find({ grupoId }).populate('parent');
    res.json(categorias);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/categorias", authMiddleware, async (req, res) => {
  try {
    const { phone, nome, parentId, icone } = req.body;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const categoria = await Categoria.create({ grupoId, nome, parent: parentId || null, icone: icone || "📦" });
    res.json(categoria);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put("/api/categorias/:id", authMiddleware, async (req, res) => {
  try {
    const { nome, parentId, icone, cor, arquivada } = req.body;
    const atualizacao = {};
    if (nome !== undefined) atualizacao.nome = nome;
    if (parentId !== undefined) atualizacao.parent = parentId || null;
    if (icone !== undefined) atualizacao.icone = icone;
    if (cor !== undefined) atualizacao.cor = cor;
    if (arquivada !== undefined) atualizacao.arquivada = arquivada;
    
    const categoria = await Categoria.findByIdAndUpdate(req.params.id, atualizacao, { new: true });
    if (!categoria) return res.status(404).json({ erro: "Categoria não encontrada" });
    res.json(categoria);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete("/api/categorias/:id", authMiddleware, async (req, res) => {
  try {
    await Categoria.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// --- LIMITES (GERAL E POR CATEGORIA) ---
app.get("/api/limites/:phone", authMiddleware, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const rawPhone = normalizarPhone(req.params.phone);
    const user = await User.findOne({ phone: rawPhone });
    const limitesCategoria = await CategoryLimit.find({ grupoId, mesReferencia: new Date().toISOString().slice(0,7) });
    res.json({ metaMensal: user?.metaMensal || 0, categorias: limitesCategoria });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/limites/geral", authMiddleware, async (req, res) => {
  try {
    const { phone, valor } = req.body;
    const user = await User.findOneAndUpdate({ phone }, { metaMensal: valor }, { upsert: true, new: true });
    res.json({ metaMensal: user.metaMensal });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/limites/categoria", authMiddleware, async (req, res) => {
  try {
    const { phone, categoria, limiteMensal, percentualAlerta } = req.body;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const mesRef = new Date().toISOString().slice(0,7);
    const updateData = { limiteMensal };
    if (percentualAlerta !== undefined) {
      updateData.percentualAlerta = percentualAlerta;
    }
    const limite = await CategoryLimit.findOneAndUpdate(
      { grupoId, categoria, mesReferencia: mesRef },
      updateData,
      { upsert: true, new: true }
    );
    res.json(limite);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ================= ROTAS DE INVESTIMENTOS =================
app.get("/api/investimentos/:phone", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const investimentos = await Investimento.find({ grupoId });
    res.json(investimentos);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/investimentos/distribuicao/:phone", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const investimentos = await Investimento.find({ grupoId });
    if (investimentos.length === 0) return res.json({ distribui: [], total: 0 });
    const agrupado = {};
    let total = 0;
    for (const inv of investimentos) {
      const tipo = inv.tipo;
      const valorAtual = inv.valorAtual || inv.valorAportado;
      agrupado[tipo] = (agrupado[tipo] || 0) + valorAtual;
      total += valorAtual;
    }
    const distribui = Object.keys(agrupado).map(tipo => ({
      tipo,
      valor: agrupado[tipo],
      percentual: total > 0 ? (agrupado[tipo] / total) * 100 : 0
    })).sort((a,b) => b.percentual - a.percentual);
    res.json({ distribui, total });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/investimentos", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const { phone, tipo, nome, ticker, quantidade, precoUnitario, valorAportado, dataCompra } = req.body;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const investimento = await Investimento.create({
      grupoId, tipo, nome, ticker, quantidade, precoUnitario, valorAportado, dataCompra,
      valorAtual: quantidade * precoUnitario,
      rentabilidade: 0
    });
    res.json(investimento);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put("/api/investimentos/:id", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const { quantidade, precoUnitario, valorAtual } = req.body;
    const investimento = await Investimento.findByIdAndUpdate(
      req.params.id,
      { quantidade, precoUnitario, valorAtual },
      { new: true }
    );
    res.json(investimento);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete("/api/investimentos/:id", authMiddleware, async (req, res) => {
  try {
    await Investimento.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/metas/:phone", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const metas = await Meta.find({ grupoId });
    res.json(metas);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/metas", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const { phone, nome, valorObjetivo, prazoAnos, taxaAnual, investimentoId } = req.body;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const jurosMensal = Math.pow(1 + (taxaAnual / 100), 1/12) - 1;
    const n = prazoAnos * 12;
    let aporteMensal = (valorObjetivo * jurosMensal) / (Math.pow(1 + jurosMensal, n) - 1);
    if (!isFinite(aporteMensal)) aporteMensal = valorObjetivo / n;
    const meta = await Meta.create({
      grupoId, nome, valorObjetivo, prazoAnos, taxaAnual,
      aporteMensalSugerido: parseFloat(aporteMensal.toFixed(2)),
      investimentoId: investimentoId || null
    });
    res.json(meta);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete("/api/metas/:id", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    await Meta.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/aportes/:phone", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const aportes = await Aporte.find({ grupoId }).sort({ data: -1 });
    res.json(aportes);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/aportes", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const { phone, valor, investimentoId, descricao } = req.body;
    const grupoId = await getGrupoFromPhone(phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });
    const aporte = await Aporte.create({
      grupoId,
      valor,
      investimentoId: investimentoId || null,
      descricao: descricao || "Aporte manual",
      data: new Date()
    });
    if (investimentoId) {
      const inv = await Investimento.findById(investimentoId);
      if (inv) {
        inv.valorAportado += valor;
        inv.valorAtual += valor;
        await inv.save();
      }
    }
    res.json({ ok: true, aporte });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/evolucao-patrimonio/:phone", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    const grupoId = await getGrupoFromPhone(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: "Grupo não encontrado" });
    const historico = await PatrimonioHistorico.find({ grupoId }).sort({ data: 1 });
    res.json(historico);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/renda-media/:phone", authMiddleware, checkInvestimentosPlan, async (req, res) => {
  try {
    res.json({ rendaMediaMensal: 0 });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/api/grupo/:id", authMiddleware, async (req, res) => {
  try {
    const grupo = await Grupo.findById(req.params.id).populate('membros.userId', 'name phone');
    if (!grupo) return res.status(404).json({ erro: "Grupo não encontrado" });
    res.json(grupo);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// --- CRON JOB PARA SNAPSHOTS DIÁRIOS ---
cron.schedule('59 23 * * *', async () => {
  console.log("Criando snapshots diários de investimentos e patrimônio...");
  const usuarios = await User.find({});
  const gruposProcessados = new Set();
  for (const user of usuarios) {
    const grupoId = user.grupoAtivo;
    if (!grupoId || gruposProcessados.has(grupoId.toString())) continue;
    gruposProcessados.add(grupoId.toString());
    const isBlack = await verificarPlanoInvestimentos(user.phone);
    if (!isBlack) continue;
    const investimentos = await Investimento.find({ grupoId });
    for (const inv of investimentos) {
      await HistoricoInvestimento.create({
        grupoId,
        investimentoId: inv._id,
        data: new Date(),
        valorAtual: inv.valorAtual
      });
    }
    let patrimonioInvest = 0;
    for (const inv of investimentos) patrimonioInvest += inv.valorAtual;
    const walletSaldo = await Wallet.aggregate([
      { $match: { grupoId } },
      { $group: { _id: null, total: { $sum: "$saldo" } } }
    ]);
    const saldoWallets = walletSaldo[0]?.total || 0;
    const patrimonioTotal = patrimonioInvest + saldoWallets;
    const diaAnterior = new Date();
    diaAnterior.setDate(diaAnterior.getDate() - 1);
    const registroAnterior = await PatrimonioHistorico.findOne({ grupoId, data: { $gte: diaAnterior } }).sort({ data: -1 });
    let rentabilidade = 0;
    if (registroAnterior && registroAnterior.patrimonioTotal > 0) {
      rentabilidade = ((patrimonioTotal - registroAnterior.patrimonioTotal) / registroAnterior.patrimonioTotal) * 100;
    }
    await PatrimonioHistorico.create({
      grupoId,
      data: new Date(),
      patrimonioTotal,
      rentabilidadePeriodo: rentabilidade
    });
  }
  console.log("Snapshots concluídos.");
});

// --- CRON JOB (recorrências, lembretes, parcelas e fatura) ---
cron.schedule('0 * * * *', async () => {
  const hoje = new Date();
  if (hoje.getDate() === 1) {
    const mesAtual = hoje.toISOString().slice(0,7);
    await CategoryLimit.updateMany(
      { mesReferencia: { $ne: mesAtual }, alertaEnviado: true },
      { alertaEnviado: false }
    );
    console.log("✅ Alertas de limite resetados para o novo mês");
  }
  console.log("Processando tarefas agendadas...");
  const dia = hoje.getDate();
  const inicioHoje = new Date(); inicioHoje.setHours(0,0,0,0);
  const fimHoje = new Date(); fimHoje.setHours(23,59,59,999);

  const contasHoje = await Recorrencia.find({ diaVencimento: dia, ativa: true });
  for (const conta of contasHoje) {
    const jaLancado = await Finance.findOne({ grupoId: conta.grupoId, categoria: conta.categoria, valor: conta.valor, data: { $gte: inicioHoje, $lte: fimHoje } });
    if (!jaLancado) {
      const idTransacao = nanoid(6);
      const carteiraAlvo = conta.carteira || "DINHEIRO";
      await Finance.create({
        grupoId: conta.grupoId,
        idCurto: idTransacao,
        tipo: conta.tipo,
        categoria: conta.categoria,
        valor: conta.valor,
        observacao: `[Recorrente] ${conta.descricao || ''} [${carteiraAlvo}]`
      });
      await Wallet.findOneAndUpdate({ grupoId: conta.grupoId, nome: carteiraAlvo }, { $inc: { saldo: conta.tipo === "Gasto" ? -conta.valor : conta.valor } });
      const grupo = await Grupo.findById(conta.grupoId);
      if (grupo && grupo.donoId) {
        const dono = await User.findById(grupo.donoId);
        if (dono) await sendZap(dono.phone, `👴 *Registro automático:* Gastou R$ ${conta.valor.toFixed(2)} em ${carteiraAlvo} - ${conta.descricao} (ID: ${idTransacao})`);
      }
    }
  }

  const lembretes = await Reminder.find({ dataVencimento: { $gte: inicioHoje, $lt: fimHoje }, enviado: false, ativo: true });
  for (const lembrete of lembretes) {
    const grupo = await Grupo.findById(lembrete.grupoId);
    if (grupo && grupo.donoId) {
      const dono = await User.findById(grupo.donoId);
      if (dono) await sendZap(dono.phone, `🔔 *LEMBRETE*: ${lembrete.tipo === "pagar" ? "💸 Pagar" : "💰 Receber"} *${lembrete.descricao}* no valor de R$ ${lembrete.valor.toFixed(2)} até ${lembrete.dataVencimento.toLocaleDateString('pt-BR')}.`);
    }
    lembrete.enviado = true;
    await lembrete.save();
  }

  const parcelasVencendo = await Parcela.find({ dataProximaVencimento: { $lte: hoje }, ativa: true });
  for (const parcela of parcelasVencendo) {
    if (parcela.parcelasPagas < parcela.totalParcelas) {
      const grupo = await Grupo.findById(parcela.grupoId);
      if (grupo && grupo.donoId) {
        const dono = await User.findById(grupo.donoId);
        if (dono) await sendZap(dono.phone, `🔔 *PARCELA VENCE HOJE*: ${parcela.descricao} - ${parcela.parcelasPagas+1}/${parcela.totalParcelas} - Valor: R$ ${parcela.valorParcela.toFixed(2)}.\nPague com "transferir ${parcela.valorParcela} do [debito] para ${parcela.carteira}".`);
      }
    }
  }

  const users = await User.find({ diaFechamentoFatura: { $exists: true } });
  for (const user of users) {
    if (hoje.getDate() === user.diaFechamentoFatura) {
      const grupoId = user.grupoAtivo;
      if (!grupoId) continue;
      let inicioPeriodo = user.ultimoFechamento || new Date(hoje.getFullYear(), hoje.getMonth()-1, user.diaFechamentoFatura);
      if (!user.ultimoFechamento) inicioPeriodo = new Date(hoje.getFullYear(), hoje.getMonth()-1, user.diaFechamentoFatura);
      const fimPeriodo = hoje;
      const parcelasPeriodo = await Parcela.find({
        grupoId,
        dataProximaVencimento: { $gte: inicioPeriodo, $lte: fimPeriodo },
        ativa: true
      });
      let totalFatura = 0;
      for (const p of parcelasPeriodo) totalFatura += p.valorParcela;
      const comprasAvista = await Finance.find({
        grupoId,
        tipo: "Gasto",
        data: { $gte: inicioPeriodo, $lte: fimPeriodo },
        observacao: { $regex: /Crédito/i }
      });
      for (const c of comprasAvista) totalFatura += c.valor;
      await sendZap(user.phone, `💳 *FATURA DO CARTÃO* - Período: ${inicioPeriodo.toLocaleDateString()} a ${fimPeriodo.toLocaleDateString()}\nValor total: R$ ${totalFatura.toFixed(2)}\nVencimento: aproximadamente dia ${user.diaFechamentoFatura+5}.\nPara pagar, use "transferir ${totalFatura.toFixed(2)} do [conta_debito] para [conta_credito]".`);
      user.ultimoFechamento = hoje;
      await user.save();
    }
  }
});

// Cron job para atualizar investimentos com ticker via Yahoo Finance (todos os dias às 3h)
cron.schedule('0 3 * * *', async () => {
  console.log("🔄 Iniciando atualização automática de investimentos via Yahoo Finance...");
  
  // Busca todos os investimentos que possuem ticker (em qualquer grupo)
  const investimentos = await Investimento.find({ ticker: { $ne: null } });
  console.log(`📊 Encontrados ${investimentos.length} investimentos com ticker.`);
  
  if (investimentos.length === 0) return;

  let atualizados = 0;
  let erros = 0;
  
  for (const inv of investimentos) {
    try {
      // Busca preço e dividendos desde a data da compra
      const dados = await buscarDadosYahoo(inv.ticker, inv.dataCompra);
      if (!dados) {
        console.warn(`⚠️ Nenhum dado para ${inv.ticker} (investimento ${inv.nome})`);
        erros++;
        continue;
      }
      
      const { precoAtual, dividendosAcumulados: dividendosPorAcao } = dados;
      
      // Atualiza valor atual (preço * quantidade)
      const novoValorAtual = precoAtual * inv.quantidade;
      // Dividendos totais recebidos até agora
      const dividendosTotais = dividendosPorAcao * inv.quantidade;
      
      // Só atualiza se houve mudança significativa (opcional: evitar gravações desnecessárias)
      if (novoValorAtual !== inv.valorAtual || dividendosTotais !== inv.dividendosAcumulados) {
        inv.valorAtual = novoValorAtual;
        inv.dividendosAcumulados = dividendosTotais;
        
        // Recalcula rentabilidade total (preço + dividendos)
        const valorTotal = inv.valorAtual + inv.dividendosAcumulados;
        const rentabilidadeTotal = ((valorTotal - inv.valorAportado) / inv.valorAportado) * 100;
        inv.rentabilidade = rentabilidadeTotal / 100; // armazena como decimal (0.15 para 15%)
        inv.ultimaAtualizacao = new Date();
        
        await inv.save();
        atualizados++;
        console.log(`✅ ${inv.nome} (${inv.ticker}) atualizado: Preço R$ ${precoAtual.toFixed(2)}, Dividendos acumulados R$ ${dividendosTotais.toFixed(2)}, Rentabilidade ${rentabilidadeTotal.toFixed(2)}%`);
      } else {
        console.log(`⏭️ ${inv.nome} (${inv.ticker}) sem alterações.`);
      }
      
      // Aguarda 1 segundo entre requisições para evitar bloqueio (rate limit)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (err) {
      console.error(`❌ Erro ao atualizar ${inv.nome} (${inv.ticker}):`, err.message);
      erros++;
    }
  }
  
  console.log(`🏁 Atualização concluída: ${atualizados} atualizados, ${erros} erros.`);
});

// ========== POPULAR CATEGORIAS PADRÃO ==========
async function criarCategoriasPadrao(grupoId) {
  console.log(`🔍 Verificando categorias para grupo ${grupoId}`);
  const count = await Categoria.countDocuments({ grupoId });
  console.log(`📊 Count: ${count}`);
  if (count === 0) {
    const categoriasPadrao = Object.keys(EMOJIS_CATEGORIAS).map(nome => ({
      grupoId,
      nome,
      icone: EMOJIS_CATEGORIAS[nome],
      ativa: true,
      parent: null
    }));
    const inserted = await Categoria.insertMany(categoriasPadrao);
    console.log(`📂 Categorias principais criadas para grupo ${grupoId} (${inserted.length} categorias)`);

    const mapa = {};
    for (const cat of inserted) mapa[cat.nome] = cat._id;

    const subcategorias = [];
    if (mapa["Assinaturas"]) {
      const subs = ["Netflix", "HBO Max", "Disney+", "Globo Play", "Prime Video", "IPTV", "Spotify"];
      for (const sub of subs) subcategorias.push({ grupoId, nome: sub, icone: "📺", parent: mapa["Assinaturas"], ativa: true });
    }
    if (mapa["Vestuário"]) {
      const subs = ["Shein", "Adidas", "Nike"];
      for (const sub of subs) subcategorias.push({ grupoId, nome: sub, icone: "👕", parent: mapa["Vestuário"], ativa: true });
    }
    if (mapa["Alimentação"]) {
      const subs = ["Fastfood"];
      for (const sub of subs) subcategorias.push({ grupoId, nome: sub, icone: "🍔", parent: mapa["Alimentação"], ativa: true });
    }
    if (mapa["Casa"]) {
      const subs = ["Conta de luz", "Conta de água", "Gás"];
      for (const sub of subs) subcategorias.push({ grupoId, nome: sub, icone: "🏡", parent: mapa["Casa"], ativa: true });
    }
    if (mapa["Lazer e Entretenimento"]) {
      const subs = ["Festas"];
      for (const sub of subs) subcategorias.push({ grupoId, nome: sub, icone: "🎉", parent: mapa["Lazer e Entretenimento"], ativa: true });
    }
    if (mapa["Transferências"]) {
      const subs = ["PIX", "TED", "DOC", "Boleto", "Transferência entre contas"];
      for (const sub of subs) {
        subcategorias.push({
          grupoId, nome: sub,
          icone: sub === "PIX" ? "💸" : (sub === "Boleto" ? "📄" : "🔄"),
          parent: mapa["Transferências"],
          ativa: true
        });
      }
    }
    if (subcategorias.length) {
      await Categoria.insertMany(subcategorias);
      console.log(`📂 Subcategorias criadas para grupo ${grupoId} (${subcategorias.length} subcategorias)`);
    }
    return true;
  }
  console.log(`⚠️ Categorias já existem para grupo ${grupoId}`);
  return false;
}

// Rota para obter o perfil do usuário (incluindo grupo ativo)
app.get("/api/user/:phone", authMiddleware, async (req, res) => {
  try {
    const rawPhone = normalizarPhone(req.params.phone);
    let user = await User.findOne({ phone: rawPhone });
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    
    if (!user.grupoAtivo) {
      const grupo = await Grupo.create({
        nome: "Pessoal",
        donoId: user._id,
        membros: [{ userId: user._id, papel: "admin" }],
        codigoConvite: null
      });
      user.grupoAtivo = grupo._id;
      await user.save();
      
      await Wallet.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Finance.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Recorrencia.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await CategoryLimit.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Reminder.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Parcela.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Categoria.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Investimento.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Aporte.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await Meta.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await HistoricoInvestimento.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      await PatrimonioHistorico.updateMany({ phone: user.phone }, { grupoId: grupo._id });
      
      await criarCategoriasPadrao(grupo._id);
    }
    
    const userComGrupo = await User.findById(user._id).populate('grupoAtivo');
    res.json({ 
      phone: userComGrupo.phone, 
      name: userComGrupo.name, 
      plano: userComGrupo.plano, 
      grupoAtivo: userComGrupo.grupoAtivo 
    });
  } catch (err) {
    console.error("Erro na rota /api/user/:phone:", err);
    res.status(500).json({ erro: err.message });
  }
});

// Rota para listar todos os grupos do usuário
app.get("/api/meus-grupos/:phone", authMiddleware, async (req, res) => {
  try {
    const rawPhone = normalizarPhone(req.params.phone);
    const user = await User.findOne({ phone: rawPhone });
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    const grupos = await Grupo.find({ "membros.userId": user._id });
    res.json(grupos);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Rota para trocar o grupo ativo
app.post("/api/trocar-grupo", authMiddleware, async (req, res) => {
  try {
    let { phone, grupoId } = req.body;
    phone = normalizarPhone(phone);
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    const grupo = await Grupo.findById(grupoId);
    if (!grupo) return res.status(404).json({ erro: "Grupo não encontrado" });
    if (!grupo.membros.some(m => m.userId.toString() === user._id.toString())) {
      return res.status(403).json({ erro: "Você não faz parte deste grupo" });
    }
    user.grupoAtivo = grupoId;
    await user.save();
    res.json({ ok: true, grupoAtivo: grupoId });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Rota para gerar código de convite (admin)
app.post("/api/convidar-grupo", authMiddleware, async (req, res) => {
  try {
    let { phone, grupoId } = req.body;
    phone = normalizarPhone(phone);
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    const grupo = await Grupo.findById(grupoId);
    if (!grupo) return res.status(404).json({ erro: "Grupo não encontrado" });
    if (grupo.donoId.toString() !== user._id.toString()) {
      return res.status(403).json({ erro: "Apenas o administrador pode gerar convites" });
    }
    const codigo = nanoid(6).toUpperCase();
    await Convite.create({
      grupoId: grupo._id,
      codigo,
      criadoPor: user._id,
      expiraEm: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    res.json({ codigo });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Rota para aceitar convite (entrar em grupo)
app.post("/api/aceitar-convite", authMiddleware, async (req, res) => {
  try {
    let { phone, codigo } = req.body;
    phone = normalizarPhone(phone);
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    const convite = await Convite.findOne({ codigo, usado: false, expiraEm: { $gt: new Date() } });
    if (!convite) return res.status(400).json({ erro: "Código inválido ou expirado" });
    const grupo = await Grupo.findById(convite.grupoId);
    if (!grupo) return res.status(404).json({ erro: "Grupo não encontrado" });
    const dono = await User.findById(grupo.donoId);
    let maxMembros = 1;
    if (dono.plano === 'premium') maxMembros = 3;
    else if (dono.plano === 'black') maxMembros = 5;
    if (grupo.membros.length >= maxMembros) {
      return res.status(400).json({ erro: `Limite de membros atingido (${maxMembros})` });
    }
    if (grupo.membros.some(m => m.userId.toString() === user._id.toString())) {
      return res.status(400).json({ erro: "Você já está neste grupo" });
    }
    grupo.membros.push({ userId: user._id, papel: "escrita" });
    await grupo.save();
    convite.usado = true;
    await convite.save();
    user.grupoAtivo = grupo._id;
    await user.save();
    res.json({ ok: true, grupo });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Rota para remover membro (admin)
app.post("/api/remover-membro", authMiddleware, async (req, res) => {
  try {
    let { phone, grupoId, membroId } = req.body;
    phone = normalizarPhone(phone);
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ erro: "Usuário não encontrado" });
    const grupo = await Grupo.findById(grupoId);
    if (!grupo) return res.status(404).json({ erro: "Grupo não encontrado" });
    if (grupo.donoId.toString() !== user._id.toString()) {
      return res.status(403).json({ erro: "Apenas o administrador pode remover membros" });
    }
    const membro = grupo.membros.find(m => m.userId.toString() === membroId);
    if (!membro) return res.status(404).json({ erro: "Membro não encontrado" });
    grupo.membros = grupo.membros.filter(m => m.userId.toString() !== membroId);
    await grupo.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// --- MIGRAÇÃO DE DADOS EXISTENTES ---
(async () => {
  try {
    try {
      await Grupo.collection.dropIndex('codigoConvite_1');
      console.log("✅ Índice antigo removido.");
    } catch (e) { /* índice não existia */ }
    await Grupo.collection.createIndex({ codigoConvite: 1 }, { sparse: true });
    console.log("✅ Índice corrigido (sem unique).");
    const users = await User.find({});
    for (const user of users) {
      if (!user.grupoAtivo) {
        let grupo = await Grupo.findOne({ donoId: user._id, nome: "Pessoal" });
        if (!grupo) {
          grupo = await Grupo.create({
            nome: "Pessoal",
            donoId: user._id,
            membros: [{ userId: user._id, papel: "admin" }],
            codigoConvite: null
          });
        }
        user.grupoAtivo = grupo._id;
        await user.save();
        await Wallet.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Finance.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Recorrencia.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await CategoryLimit.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Reminder.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Parcela.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Categoria.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Investimento.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Aporte.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await Meta.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await HistoricoInvestimento.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await PatrimonioHistorico.updateMany({ phone: user.phone }, { grupoId: grupo._id });
        await criarCategoriasPadrao(grupo._id);
      }
    }
    console.log("✅ Migração de grupos concluída.");
  } catch (err) {
    console.error("Erro durante migração de grupos:", err);
  }
})();

// ========== IMPORTAÇÃO OFX ==========
app.post("/api/importar-ofx", authMiddleware, async (req, res) => {
  try {
    let { phone } = req.body;
    phone = normalizarPhone(phone);
    const user = await User.findOne({ phone });
    if (!user || (user.plano !== 'premium' && user.plano !== 'black')) {
      return res.status(403).json({ erro: "Funcionalidade exclusiva para planos Premium e Black" });
    }
    res.json({ msg: "Funcionalidade OFX em desenvolvimento. Em breve!" });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot Sora rodando na porta ${PORT} 🚀`));
