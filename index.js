require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

const { 
  OPENAI_API_KEY, ZAPI_TOKEN, ZAPI_INSTANCE, MONGODB_URI, ZAPI_CLIENT_TOKEN 
} = process.env;

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB conectado 🔥"))
  .catch(err => console.log("Erro MongoDB:", err));

// --- MODELOS DE DADOS ---

// Modelo de Gastos
const Finance = mongoose.model("Finance", new mongoose.Schema({
  phone: String,
  tipo: String,
  categoria: String,
  valor: Number,
  observacao: String,
  data: { type: Date, default: Date.now }
}));

// Modelo de Usuários (NOVO)
const User = mongoose.model("User", new mongoose.Schema({
  phone: String,
  name: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}));

// --- FUNÇÃO DE ENVIO Z-API ---
async function sendZap(phone, message) {
  try {
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      { phone, message },
      { headers: { "Content-Type": "application/json", "client-token": ZAPI_CLIENT_TOKEN } }
    );
  } catch (e) { console.log("Erro envio:", e.message); }
}

// --- WEBHOOK PRINCIPAL ---
app.post("/webhook", async (req, res) => {
  const { phone, text } = req.body;
  const message = text?.message;

  if (!message || !phone) return res.sendStatus(200);

  try {
    // 1. VERIFICAR SE O USUÁRIO JÁ EXISTE
    let user = await User.findOne({ phone });

    // 2. SE NÃO EXISTE, É UM NOVO CADASTRO
    if (!user) {
      // Se for a primeira mensagem, iniciamos o cadastro
      // Se a mensagem for só o nome, salvamos. Mas vamos usar a IA para extrair o nome de forma limpa.
      const nameResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "O usuário está se apresentando. Extraia APENAS o primeiro nome dele. Se não houver nome, responda 'PEDIR'." }, { role: "user", content: message }],
        temperature: 0
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

      const extractedName = nameResponse.data.choices[0].message.content.trim();

      if (extractedName === "PEDIR") {
        await sendZap(phone, "👋 Olá! Sou seu novo Assistente Financeiro IA. \n\nAinda não te conheço. *Qual é o seu nome?*");
        return res.sendStatus(200);
      } else {
        await User.create({ phone, name: extractedName });
        await sendZap(phone, `Prazer em te conhecer, *${extractedName}*! 🎉\n\nAgora você já pode anotar seus gastos. Exemplo:\n- "Almoço 35 reais"\n- "Recebi 2000 de salário"\n- "Resumo"`);
        return res.sendStatus(200);
      }
    }

    // 3. SE JÁ EXISTE, SEGUE O FLUXO NORMAL
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Você é o assistente de ${user.name}. 
          Responda em JSON:
          1. Salvar: {"acao": "salvar", "tipo": "Gasto/Recebimento", "categoria": "", "valor": 0, "observacao": ""}
          2. Resumo: {"acao": "resumo"}
          3. Conversa: {"acao": "conversa", "resposta": ""}`
        },
        { role: "user", content: message }
      ],
      temperature: 0
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

    let aiReply = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    let data = JSON.parse(aiReply);

    if (data.acao === "salvar") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      await Finance.create({ phone, tipo: data.tipo, categoria: data.categoria, valor: valorLimpo, observacao: data.observacao });
      await sendZap(phone, `✅ *Lançado, ${user.name}!*\n💰 R$ ${valorLimpo.toFixed(2)} em *${data.categoria}*`);
    } 
    
    else if (data.acao === "resumo") {
      const inicioMes = new Date();
      inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);

      const resumoCategorias = await Finance.aggregate([
        { $match: { phone, tipo: "Gasto", data: { $gte: inicioMes } } },
        { $group: { _id: "$categoria", total: { $sum: "$valor" } } },
        { $sort: { total: -1 } }
      ]);

      const totaisGerais = await Finance.find({ phone, data: { $gte: inicioMes } });
      let totalGastos = 0, totalReceitas = 0;
      totaisGerais.forEach(r => r.tipo === "Gasto" ? totalGastos += r.valor : totalReceitas += r.valor);

      let textoCategorias = resumoCategorias.map(c => `🔹 *${c._id}:* R$ ${c.total.toFixed(2)}`).join('\n') || "Sem gastos.";

      await sendZap(phone, `📊 *RELATÓRIO DE ${user.name.toUpperCase()}*\n\n📈 *GASTOS POR CATEGORIA:*\n${textoCategorias}\n\n--------------------------\n🔴 Gastos: R$ ${totalGastos.toFixed(2)}\n🟢 Receitas: R$ ${totalReceitas.toFixed(2)}\n💰 *SALDO: R$ ${(totalReceitas - totalGastos).toFixed(2)}*`);
    } 
    
    else {
      await sendZap(phone, data.resposta || `Oi ${user.name}, como posso ajudar?`);
    }

  } catch (error) {
    console.log("Erro:", error.message);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de Vendas Ativo 🚀`));
