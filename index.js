require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 10000;

/* ==========================================
   ⚙️ CONFIG
========================================== */

const lineConfig = {
    channelAccessToken: process.env.LINE_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY');
    process.exit(1);
}

const client = new line.Client(lineConfig);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

/* ==========================================
   🟢 WEBHOOK
========================================== */

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(result => res.json(result))
        .catch(err => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

app.use(express.json());
app.use(express.static('public', { extensions: ['html'] }));

/* ==========================================
   👥 MEMBER SYNC FUNCTION
========================================== */

async function syncMember(event) {
    if (event.source.type !== 'group') return;

    const groupId = event.source.groupId;
    const userId = event.source.userId;
    if (!userId) return;

    try {
        const profile = await client.getGroupMemberProfile(groupId, userId);

        await supabase.from('group_members').upsert([{
            group_id: groupId,
            user_id: userId,
            display_name: profile.displayName,
            picture_url: profile.pictureUrl
        }], { onConflict: 'group_id,user_id' });

    } catch (err) {
        console.error("Member sync error:", err.message);
    }
}

/* ==========================================
   💬 HANDLE EVENT
========================================== */

async function handleEvent(event) {

    if (
        event.replyToken === '00000000000000000000000000000000' ||
        event.replyToken === 'ffffffffffffffffffffffffffffffff'
    ) return null;

    await syncMember(event);

    const groupId =
        event.source.type === 'group'
            ? event.source.groupId
            : event.source.type === 'room'
                ? event.source.roomId
                : event.source.userId;

    const baseUrl = process.env.BASE_URL || 'https://line.me';

    /* ================= JOIN / FOLLOW ================= */

    if (event.type === 'join' || event.type === 'follow') {

        const welcomeFlex = {
            type: "flex",
            altText: "สวัสดีเมี๊ยว! ขาวมณีพร้อมช่วยงานแล้ว",
            contents: {
                type: "bubble",
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: "ขาวมณีมาแล้วเมี๊ยว 🐱", weight: "bold", size: "lg" },
                        { type: "text", text: "กดดูงานหรือจดงานใหม่ได้เลย", margin: "md" }
                    ]
                }
            }
        };

        return client.replyMessage(event.replyToken, [
            { type: 'text', text: 'สวัสดีเมี๊ยว! ขาวมณีมาแล้วเจ้าค่ะ' },
            welcomeFlex
        ]);
    }

    /* ================= MESSAGE ================= */

    if (event.type === 'message' && event.message.type === 'text') {

        const userText = event.message.text.trim();

        if (userText === 'ขาวมณี') {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'เรียกขาวมณีมีอะไรให้ช่วยไหมเมี๊ยว?',
                quickReply: {
                    items: [
                        { type: 'action', action: { type: 'uri', label: '📋 กระดานงาน', uri: `${baseUrl}/?groupId=${groupId}` } },
                        { type: 'action', action: { type: 'uri', label: '📝 จดงานใหม่', uri: `${baseUrl}/add-task?groupId=${groupId}` } }
                    ]
                }
            });
        }

        /* ========= AI CREATE TASK ========= */

        if (userText.startsWith('ขาวมณีจด')) {
            const taskCommand = userText.replace('ขาวมณีจด', '').trim();

            try {
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                const prompt = `
                สกัดข้อมูลงานเป็น JSON:
                { "taskName": "...", "assignee": "..." }
                จากข้อความ: "${taskCommand}"
                `;

                const result = await model.generateContent(prompt);
                const raw = result.response.text().replace(/```json|```/g, '').trim();
                const taskData = JSON.parse(raw);

                await supabase.from('tasks').insert([{
                    task_name: taskData.taskName || "งานที่ไม่ได้ตั้งชื่อ",
                    assignee: taskData.assignee || "ยังไม่ระบุ",
                    status: 'todo',
                    group_id: groupId
                }]);

                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `📝 จดงาน "${taskData.taskName}" ให้แล้วเมี๊ยว!`
                });

            } catch (err) {
                console.error(err);
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: "ขาวมณีงง พิมพ์ใหม่อีกทีนะเมี๊ยว 🐾"
                });
            }
        }
    }

    return null;
}

/* ==========================================
   🌐 API
========================================== */

app.get('/api/tasks', async (req, res) => {
    const { groupId } = req.query;

    let query = supabase.from('tasks')
        .select('*')
        .order('created_at', { ascending: false });

    if (groupId) query = query.eq('group_id', groupId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
});

app.get('/api/members', async (req, res) => {
    const { groupId } = req.query;

    const { data, error } = await supabase
        .from('group_members')
        .select('*')
        .eq('group_id', groupId);

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
});

/* ==========================================
   ⏰ CRON
========================================== */

cron.schedule('0 8 * * *', async () => {
    try {
        const { data: pendingTasks } = await supabase
            .from('tasks')
            .select('*')
            .eq('status', 'todo');

        if (!pendingTasks || pendingTasks.length === 0) return;

        const tasksByGroup = {};

        pendingTasks.forEach(t => {
            if (!tasksByGroup[t.group_id]) tasksByGroup[t.group_id] = [];
            tasksByGroup[t.group_id].push(t);
        });

        for (const [gId, tasks] of Object.entries(tasksByGroup)) {
            if (!gId || gId === 'personal') continue;

            const taskNames = tasks.map(t => `- ${t.task_name}`).join('\n');

            await client.pushMessage(gId, {
                type: 'text',
                text: `⏰ งานค้างวันนี้เมี๊ยว:\n${taskNames}`
            });
        }

    } catch (err) {
        console.error("Cron Error:", err);
    }
});

/* ==========================================
   🚀 START
========================================== */

app.listen(port, () => {
    console.log(`🚀 ขาวมณีพร้อมในพอร์ต ${port}`);
});