require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const cors = require('cors'); 

const app = express(); // Primeiro criamos o app
app.use(cors());       // Depois liberamos o CORS
app.use(express.json());

const { 
  OPENAI_API_KEY, ZAPI_TOKEN, ZAPI_INSTANCE, MONGODB_URI, ZAPI_CLIENT_TOKEN 
} = process.env;

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB conectado 🔥"))
  .catch(err => console.log("Erro MongoDB:", err));

// --- MODELOS ---
const Finance = mongoose.model("Finance", new mongoose.Schema({
  phone: String, tipo: String, categoria: String, valor: Number, observacao: String, data: { type: Date, default: Date.now }
}));

const User = mongoose.model("User", new mongoose.Schema({
  phone: String, name: String, metaMensal: { type: Number, default: 0 }, createdAt: { type: Date, default: Date.now }
}));

// --- FUNÇÃO DE ENVIO ---
async function sendZap(phone, message) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
    { phone, message }, 
    { headers: { "Content-Type": "application/json", "client-token": ZAPI_CLIENT_TOKEN } });
  } catch (e) { console.log("Erro envio:", e.message); }
}

app.post("/webhook", async (req, res) => {
  const { phone, text } = req.body;
  const message = text?.message;
  if (!message || !phone) return res.sendStatus(200);

  try {
    let user = await User.findOne({ phone });

    // 1. CADASTRO INICIAL
    if (!user) {
      const nameResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "Extraia o nome. Se não houver, responda 'PEDIR'." }, { role: "user", content: message }]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
      const extractedName = nameResponse.data.choices[0].message.content.trim();

      if (extractedName === "PEDIR") {
        await sendZap(phone, "👋 Olá! Qual é o seu nome para começarmos?");
        return res.sendStatus(200);
      } else {
        await User.create({ phone, name: extractedName });
        await sendZap(phone, `Bem-vindo, *${extractedName}*! 🎉\n\nJá pode anotar seus gastos. Quer definir uma meta? Digite: "Minha meta é 1000"`);
        return res.sendStatus(200);
      }
    }

    // 2. IA PARA ENTENDER A INTENÇÃO
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Usuário: ${user.name}. Responda apenas o JSON:
          1. Salvar: {"acao": "salvar", "tipo": "Gasto/Recebimento", "valor": 0, "categoria": "Ex: Mercado, Lazer, Saúde", "observacao": ""}
          2. Resumo: {"acao": "resumo"}
          3. Apagar: {"acao": "apagar"}
          4. Meta: {"acao": "set_meta", "valor": 0}
          5. Conversa: {"acao": "conversa", "resposta": ""}`
        },
        { role: "user", content: message }
      ], temperature: 0
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });

    let aiReply = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    let data = JSON.parse(aiReply);

    // --- LÓGICA DE AÇÕES ---

    if (data.acao === "set_meta") {
      user.metaMensal = data.valor;
      await user.save();
      await sendZap(phone, `🎯 Meta de gastos definida: *R$ ${data.valor.toFixed(2)}*.\nVou te avisar se chegar perto!`);
    }

    else if (data.acao === "apagar") {
      const ultimo = await Finance.findOneAndDelete({ phone }, { sort: { data: -1 } });
      if (ultimo) await sendZap(phone, `🗑️ Registro de *R$ ${ultimo.valor}* em *${ultimo.categoria}* foi removido.`);
      else await sendZap(phone, "Não encontrei nada recente para apagar.");
    }

    else if (data.acao === "salvar") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      await Finance.create({ phone, tipo: data.tipo, categoria: data.categoria, valor: valorLimpo, observacao: data.observacao });
      
      let avisoMeta = "";
      if (data.tipo === "Gasto" && user.metaMensal > 0) {
        const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
        const gastos = await Finance.find({ phone, tipo: "Gasto", data: { $gte: inicioMes } });
        const totalGasto = gastos.reduce((sum, item) => sum + item.valor, 0);

        if (totalGasto >= user.metaMensal) avisoMeta = `\n\n⚠️ *ALERTA:* Você estourou sua meta de R$ ${user.metaMensal}!`;
        else if (totalGasto >= user.metaMensal * 0.8) avisoMeta = `\n\n🟡 *ATENÇÃO:* Você atingiu 80% da sua meta (R$ ${totalGasto.toFixed(2)})!`;
      }
      await sendZap(phone, `✅ *Lançado!*\n💰 R$ ${valorLimpo.toFixed(2)} em *${data.categoria}*${avisoMeta}`);
    }

    else if (data.acao === "resumo") {
      const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);

      // Agrupamento por categoria (O que tinha sumido!)
      const categorias = await Finance.aggregate([
        { $match: { phone, tipo: "Gasto", data: { $gte: inicioMes } } },
        { $group: { _id: "$categoria", total: { $sum: "$valor" } } },
        { $sort: { total: -1 } }
      ]);

      const todos = await Finance.find({ phone, data: { $gte: inicioMes } });
      let g = 0, r = 0;
      todos.forEach(i => i.tipo === "Gasto" ? g += i.valor : r += i.valor);

      let txtCat = categorias.map(c => `🔹 *${c._id}:* R$ ${c.total.toFixed(2)}`).join('\n') || "Sem gastos detalhados.";
      let statusMeta = user.metaMensal > 0 ? `\n🎯 Meta: R$ ${user.metaMensal.toFixed(2)} (${((g/user.metaMensal)*100).toFixed(0)}%)` : "";

      await sendZap(phone, `📊 *RESUMO DE ${user.name.toUpperCase()}*${statusMeta}\n\n📈 *POR CATEGORIA:*\n${txtCat}\n\n--------------------------\n🔴 Gastos: R$ ${g.toFixed(2)}\n🟢 Receitas: R$ ${r.toFixed(2)}\n💰 *SALDO: R$ ${(r-g).toFixed(2)}*`);
    }

    else { await sendZap(phone, data.resposta || "Como posso ajudar?"); }

  } catch (error) { console.log("Erro:", error.message); }
  res.sendStatus(200);
});

// Essa é a "porta" que o Lovable vai usar
app.get("/api/transacoes", async (req, res) => {
  try {
    // Busca todas as finanças no banco e ordena pelas mais recentes
    const transacoes = await Finance.find().sort({ data: -1 });
    
    // Entrega os dados para quem pediu (no caso, o Lovable)
    res.json(transacoes);
  } catch (error) {
    res.status(500).json({ erro: "Erro ao buscar dados" });
  }
});
app.listen(process.env.PORT || 3000, () => console.log("Bot Premium On 🚀"));
