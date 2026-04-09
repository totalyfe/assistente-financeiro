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
  ZAPI_CLIENT_TOKEN // Nova variável que você adicionou no Render
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
          content: `Você é um assistente financeiro. Responda em JSON se for financeiro ou texto simples se não for.`
        },
        { role: "user", content: message }
      ]
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });

    const aiReply = response.data.choices[0].message.content;
    let data;

    try {
      data = JSON.parse(aiReply);
    } catch {
      data = { salvar: false, resposta: aiReply };
    }

    if (data.salvar) {
      await Finance.create({
        phone,
        tipo: data.tipo,
        categoria: data.categoria,
        valor: Number(data.valor.toString().replace(',', '.')),
        observacao: data.observacao
      });
      finalReply = `✅ Registrado!\n\n💸 R$ ${data.valor} - ${data.categoria}\n📝 ${data.observacao}`;
    } else {
      finalReply = data.resposta || "Não entendi, pode repetir?";
    }

    // ENVIO PARA Z-API - Agora com o cabeçalho client-token
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      {
        phone: phone,
        message: finalReply
      },
      {
        headers: {
          "Content-Type": "application/json",
          "client-token": ZAPI_CLIENT_TOKEN // O segredo está aqui!
        }
      }
    );

    console.log("Resposta enviada com sucesso! ✅");

  } catch (error) {
    console.log("Erro no processamento:", error.response?.data || error.message);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT} 🚀`));
