require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

// Variáveis do .env
const { 
  OPENAI_API_KEY, 
  ZAPI_TOKEN, 
  ZAPI_INSTANCE, 
  MONGODB_URI
} = process.env;

// Conectar MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB conectado 🔥"))
  .catch(err => console.log("Erro MongoDB:", err));

// Model de dados financeiros
const Finance = mongoose.model("Finance", new mongoose.Schema({
  phone: String,
  tipo: String,
  categoria: String,
  valor: Number,
  observacao: String,
  data: { type: Date, default: Date.now }
}));

// Webhook
app.post("/webhook", async (req, res) => {
  const { phone, text } = req.body;
  const message = text?.message;

  // Log para ver a mensagem chegando no Render
  console.log(`Mensagem recebida de ${phone}: ${message}`);

  if (!message || !phone) return res.sendStatus(200);

  let finalReply = "";

  try {
    // Chamada OpenAI
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Você é um assistente financeiro.
          Se o usuário mencionar um gasto ou receita, responda SOMENTE em JSON:
          {
           "salvar": true,
           "tipo": "Gasto ou Recebimento",
           "categoria": "",
           "valor": "",
           "observacao": ""
          }
          Se NÃO for financeiro:
          {
           "salvar": false,
           "resposta": ""
          }`
        },
        { role: "user", content: message }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
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

    // ENVIO PARA Z-API - Ajustado para evitar erro de token
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      {
        phone: phone,
        message: finalReply
      },
      {
        headers: {
          "Content-Type": "application/json"
          // Se o erro persistir, precisaremos ativar o client-token no painel e adicionar aqui
        }
      }
    );

    console.log("Resposta enviada com sucesso! ✅");

  } catch (error) {
    console.log("Erro no processamento:", error.response?.data || error.message);
  }

  res.sendStatus(200);
});

// Rodar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} 🚀`);
});
