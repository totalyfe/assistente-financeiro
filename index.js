require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

const { 
  OPENAI_API_KEY, 
  ZAPI_TOKEN, 
  ZAPI_INSTANCE, 
  MONGODB_URI,
  ZAPI_CLIENT_TOKEN 
} = process.env;

mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB conectado 🔥"))
  .catch(err => console.log("Erro MongoDB:", err));

const Finance = mongoose.model("Finance", new mongoose.Schema({
  phone: String,
  tipo: String,
  categoria: String,
  valor: Number,
  observacao: String,
  data: { type: Date, default: Date.now }
}));

app.post("/webhook", async (req, res) => {
  const { phone, text } = req.body;
  const message = text?.message;

  console.log(`Mensagem recebida de ${phone}: ${message}`);

  if (!message || !phone) return res.sendStatus(200);

  let finalReply = "";

  try {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Você é um assistente financeiro.
          
          1. Se o usuário quiser REGISTRAR um gasto/receita, responda em JSON:
          {"acao": "salvar", "tipo": "Gasto/Recebimento", "categoria": "", "valor": 0, "observacao": ""}

          2. Se o usuário quiser um RESUMO, RELATÓRIO ou saber quanto gastOU, responda em JSON:
          {"acao": "resumo"}

          3. Se for apenas conversa:
          {"acao": "conversa", "resposta": "sua resposta"}`
        },
        { role: "user", content: message }
      ],
      temperature: 0
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });

    let aiReply = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    let data = JSON.parse(aiReply);

    // LÓGICA 1: SALVAR NO BANCO
    if (data.acao === "salvar") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      await Finance.create({
        phone,
        tipo: data.tipo,
        categoria: data.categoria,
        valor: valorLimpo,
        observacao: data.observacao
      });
      finalReply = `✅ *Registrado!*\n\n💰 R$ ${valorLimpo.toFixed(2)}\n📂 ${data.categoria}`;
    } 
    
    // LÓGICA 2: GERAR RESUMO DO MÊS
    else if (data.acao === "resumo") {
      const inicioMes = new Date();
      inicioMes.setDate(1);
      inicioMes.setHours(0, 0, 0, 0);

      const registros = await Finance.find({
        phone: phone,
        data: { $gte: inicioMes }
      });

      let totalGastos = 0;
      let totalReceitas = 0;

      registros.forEach(r => {
        if (r.tipo === "Gasto") totalGastos += r.valor;
        else totalReceitas += r.valor;
      });

      finalReply = `📊 *Resumo de ${inicioMes.toLocaleString('pt-BR', { month: 'long' })}*\n\n` +
                   `🔴 Gastos: R$ ${totalGastos.toFixed(2)}\n` +
                   `🟢 Receitas: R$ ${totalReceitas.toFixed(2)}\n\n` +
                   `💰 *Saldo: R$ ${(totalReceitas - totalGastos).toFixed(2)}*`;
    } 
    
    // LÓGICA 3: CONVERSA FIADA
    else {
      finalReply = data.resposta || "Como posso ajudar?";
    }

    // ENVIAR PARA WHATSAPP
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      { phone, message: finalReply },
      { headers: { "Content-Type": "application/json", "client-token": ZAPI_CLIENT_TOKEN } }
    );

  } catch (error) {
    console.log("Erro:", error.message);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT} 🚀`));
