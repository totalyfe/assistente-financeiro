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
          content: `Você é um assistente financeiro profissional.
          
          Se o usuário descrever um gasto, despesa, compra ou recebimento de dinheiro:
          Responda OBRIGATORIAMENTE apenas um objeto JSON puro, sem textos extras:
          {
           "salvar": true,
           "tipo": "Gasto" ou "Recebimento",
           "categoria": "ex: Alimentação, Transporte, Lazer, etc",
           "valor": 0.00,
           "observacao": "detalhe curto"
          }

          Se for apenas uma saudação ou dúvida geral:
          {
           "salvar": false,
           "resposta": "Sua resposta amigável aqui"
          }`
        },
        { role: "user", content: message }
      ],
      temperature: 0 // Deixa a IA mais precisa e menos "criativa"
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });

    let aiReply = response.data.choices[0].message.content;
    
    // Limpeza extra: remove possíveis blocos de código ```json ... ```
    aiReply = aiReply.replace(/```json|```/g, "").trim();

    let data;
    try {
      data = JSON.parse(aiReply);
    } catch {
      data = { salvar: false, resposta: "Desculpe, tive um problema ao processar esse valor. Pode digitar de novo?" };
    }

    if (data.salvar) {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      
      await Finance.create({
        phone,
        tipo: data.tipo,
        categoria: data.categoria,
        valor: valorLimpo,
        observacao: data.observacao
      });

      finalReply = `✅ *Registrado com sucesso!*\n\n💰 *Valor:* R$ ${valorLimpo.toFixed(2)}\n📂 *Categoria:* ${data.categoria}\n📝 *Obs:* ${data.observacao}`;
    } else {
      finalReply = data.resposta || "Como posso ajudar com suas finanças hoje?";
    }

    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      {
        phone: phone,
        message: finalReply
      },
      {
        headers: {
          "Content-Type": "application/json",
          "client-token": ZAPI_CLIENT_TOKEN
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
