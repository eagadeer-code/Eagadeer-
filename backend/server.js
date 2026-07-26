require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { invoices: [], expenses: [], customers: [] };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const chatHistories = {};
const tools = [
  {
    name: 'create_invoice',
    description: 'Naya invoice banata hai kisi customer ke liye',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer ka naam' },
        amount: { type: 'number', description: 'Invoice ki amount' },
        description: { type: 'string', description: 'Kis cheez ka invoice hai (optional)' }
      },
      required: ['customer_name', 'amount']
    }
  },
  {
    name: 'add_expense',
    description: 'Naya business expense record karta hai',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Expense category, jaise rent, supplies, travel' },
        amount: { type: 'number', description: 'Expense ki amount' },
        note: { type: 'string', description: 'Extra detail (optional)' }
      },
      required: ['category', 'amount']
    }
  },
  {
    name: 'list_invoices',
    description: 'Saare invoices dikhata hai, optionally status se filter karke',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'paid', 'unpaid'], description: 'Filter status' }
      }
    }
  },
  {
    name: 'list_expenses',
    description: 'Saare expenses dikhata hai',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'mark_invoice_paid',
    description: 'Kisi invoice ko paid mark karta hai uski ID se',
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Invoice ki ID' }
      },
      required: ['invoice_id']
    }
  }
];

function executeTool(name, input, data) {
  switch (name) {
    case 'create_invoice': {
      const invoice = {
        id: 'INV' + Date.now().toString().slice(-6),
        customer_name: input.customer_name,
        amount: input.amount,
        description: input.description || '',
        status: 'unpaid',
        created_at: new Date().toISOString()
      };
      data.invoices.push(invoice);
      return invoice;
    }
    case 'add_expense': {
      const expense = {
        id: 'EXP' + Date.now().toString().slice(-6),
        category: input.category,
        amount: input.amount,
        note: input.note || '',
        created_at: new Date().toISOString()
      };
      data.expenses.push(expense);
      return expense;
    }
    case 'list_invoices': {
      let list = data.invoices;
      if (input.status && input.status !== 'all') {
        list = list.filter(inv => inv.status === input.status);
      }
      return list;
    }
    case 'list_expenses':
      return data.expenses;
    case 'mark_invoice_paid': {
      const inv = data.invoices.find(i => i.id === input.invoice_id);
      if (!inv) return { error: 'Invoice nahi mila' };
      inv.status = 'paid';
      return inv;
    }
    default:
      return { error: 'Unknown tool' };
  }
}

const SYSTEM_PROMPT = `Tum ek AI business assistant ho, Bookipi jaisa. Small business owners ki madad karte ho
invoicing, expense tracking mein. User Hindi/Hinglish ya English mein bolega, tum available tools use karke
unka kaam karo. Jab kaam ho jaye to friendly confirmation do (Hinglish mein). Agar zaroori detail missing ho
(jaise amount nahi bataya), to pehle poochho, tool call mat karo.`;

app.post('/api/chat', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message khaali nahi ho sakta' });
    }

    if (!chatHistories[conversationId]) chatHistories[conversationId] = [];
    const history = chatHistories[conversationId];
    const data = loadData();

    history.push({ role: 'user', content: message });

    let finalReply = '';
    let toolResults = [];
    let loopGuard = 0;

    while (loopGuard < 5) {
      loopGuard++;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: tools,
          messages: history
        })
      });

      const result = await response.json();

      if (result.error) {
        return res.status(500).json({ error: result.error.message });
      }

      history.push({ role: 'assistant', content: result.content });

      const toolUseBlocks = result.content.filter(b => b.type === 'tool_use');
      const textBlocks = result.content.filter(b => b.type === 'text');

      if (textBlocks.length) {
        finalReply += textBlocks.map(b => b.text).join('\n');
      }

      if (toolUseBlocks.length === 0) {
        break;
      }

      const toolResultContent = toolUseBlocks.map(block => {
        const output = executeTool(block.name, block.input, data);
        toolResults.push({ tool: block.name, input: block.input, output });
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(output)
        };
      });

      saveData(data);
      history.push({ role: 'user', content: toolResultContent });
    }

    res.json({
      reply: finalReply || 'Ho gaya!',
      toolsUsed: toolResults,
      data: loadData()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/api/data', (req, res) => {
  res.json(loadData());
});

app.post('/api/conversations/new', (req, res) => {
  const id = Date.now().toString();
  chatHistories[id] = [];
  res.json({ conversationId: id });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Bookipi-clone backend chal raha hai: http://localhost:${PORT}`);
});
