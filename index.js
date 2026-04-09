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

  if (!message || !phone) return res.sendStatus(200);

  try {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Você é um assistente financeiro. 
          1. Para salvar: {"acao": "salvar", "tipo": "Gasto/Recebimento", "categoria": "Ex: Mercado, Lazer, Saúde", "valor": 0, "observacao": ""}
          2. Para resumo: {"acao": "resumo"}
          3. Para conversa: {"acao": "conversa", "resposta": ""}`
        },
        { role: "user", content: message }
      ],
      temperature: 0
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });

    let aiReply = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
    let data = JSON.parse(aiReply);

    let finalReply = "";

    if (data.acao === "salvar") {
      const valorLimpo = Number(data.valor.toString().replace(',', '.'));
      await Finance.create({
        phone,
        tipo: data.tipo,
        categoria: data.categoria,
        valor: valorLimpo,
        observacao: data.observacao
      });
      finalReply = `✅ *Registrado!*\n💰 R$ ${valorLimpo.toFixed(2)} em *${data.categoria}*`;
    } 
    
    else if (data.acao === "resumo") {
      const inicioMes = new Date();
      inicioMes.setDate(1);
      inicioMes.setHours(0, 0, 0, 0);

      // BUSCA DETALHADA: Agrupando por categoria
      const resumoCategorias = await Finance.aggregate([
        { 
          $match: { 
            phone: phone, 
            tipo: "Gasto", 
            data: { $gte: inicioMes } 
          } 
        },
        { 
          $group: { 
            _id: "$categoria", 
            total: { $sum: "$valor" } 
          } 
        },
        { $sort: { total: -1 } } // Do maior gasto para o menor
      ]);

      const totaisGerais = await Finance.find({ phone, data: { $gte: inicioMes } });
      let totalGastos = 0;
      let totalReceitas = 0;
      totaisGerais.forEach(r => r.tipo === "Gasto" ? totalGastos += r.valor : totalReceitas += r.valor);

      let textoCategorias = resumoCategorias.length > 0 
        ? resumoCategorias.map(c => `🔹 *${c._id}:* R$ ${c.total.toFixed(2)}`).join('\n')
        : "Nenhum gasto detalhado ainda.";

      finalReply = `📊 *RESUMO DETALHADO - ${inicioMes.toLocaleString('pt-BR', { month: 'long' }).toUpperCase()}*\n\n` +
                   `📈 *POR CATEGORIA:*\n${textoCategorias}\n\n` +
                   `--------------------------\n` +
                   `🔴 Total Gastos: R$ ${totalGastos.toFixed(2)}\n` +
                   `🟢 Total Receitas: R$ ${totalReceitas.toFixed(2)}\n\n` +
                   `💰 *SALDO ATUAL: R$ ${(totalReceitas - totalGastos).toFixed(2)}*`;
    } 
    
    else {
      finalReply = data.resposta || "Como posso ajudar?";
    }

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
app.listen(PORT, () => console.log(`Servidor Ativo 🚀`));
