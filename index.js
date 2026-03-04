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
// 🐾 เช็คด้วยว่ามี GEMINI_API_KEY ไหม
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); 

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// 🔥 ตั้ง BASE_URL ให้ชัด ๆ
const BASE_URL = process.env.BASE_URL || 'https://khaomanee-bot.onrender.com';

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
   👥 MEMBER SYNC FUNCTION (วิชามารแอบจำชื่อ)
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
        console.error("Member sync error (อาจจะยังไม่แอดบอทเป็นเพื่อน):", err.message);
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

    // 🐾 ดักจำชื่อทุกคนที่พิมพ์ข้อความ
    await syncMember(event);

    const groupId =
        event.source.type === 'group'
            ? event.source.groupId
            : event.source.type === 'room'
                ? event.source.roomId
                : event.source.userId;

    if (event.type === 'join' || event.type === 'follow') {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'สวัสดีเมี๊ยว! ขาวมณีพร้อมช่วยงานแล้ว 🐱\nลองพิมพ์คำว่า "ขาวมณี" ดูสิครับ'
        });
    }

    if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text.trim();

        if (userText === 'ขาวมณี') {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'เลือกเมนูได้เลยเมี๊ยว 👇',
                quickReply: {
                    items: [
                        {
                            type: 'action',
                            action: {
                                type: 'uri',
                                label: '📋 กระดานงาน',
                                uri: `${BASE_URL}/?groupId=${groupId}`
                            }
                        },
                        {
                            type: 'action',
                            action: {
                                type: 'uri',
                                label: '📝 จดงานใหม่',
                                uri: `${BASE_URL}/add-task.html?groupId=${groupId}`
                            }
                        }
                    ]
                }
            });
        }
    }

    return null;
}

/* ==========================================
   🌐 API (รวมของเก่าและของใหม่ที่หน้าเว็บต้องการ)
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

app.post('/api/add-task', async (req, res) => {
    try {
        const { taskName, description, deadline, groupId } = req.body;

        if (!taskName) {
            return res.status(400).json({ success: false });
        }

        const { error } = await supabase
            .from('tasks')
            .insert([{
                task_name: taskName,
                description: description || null,
                deadline: deadline || null,
                status: 'todo',
                group_id: groupId || 'personal'
            }]);

        if (error) {
            console.error(error);
            return res.status(500).json({ success: false });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Add task error:', err);
        res.status(500).json({ success: false });
    }
});

/* --- 🚨 ส่วนที่เติมให้ใหม่ด้านล่างนี้เลยเมี๊ยว! 🚨 --- */

// 1. API สำหรับกด Checkbox เปลี่ยนสถานะงาน (Todo <-> Done)
app.post('/api/update-task', async (req, res) => {
    const { id, status } = req.body;
    const { error } = await supabase.from('tasks').update({ status }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// 2. API สำหรับอัปเดตความคืบหน้า (ใน Modal)
app.post('/api/update-progress', async (req, res) => {
    const { id, progress_note, updater_name } = req.body;
    // อัปเดตทั้ง progress_note และเปลี่ยนคนรับผิดชอบเป็นชื่อคนอัปเดตล่าสุด
    const { error } = await supabase.from('tasks').update({ 
        progress_note: progress_note,
        assignee: updater_name 
    }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// 3. API สำหรับลบงาน
app.post('/api/delete-task', async (req, res) => {
    const { id } = req.body;
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// 4. API สำหรับ AI สรุปงานแล้วส่งเข้ากลุ่ม LINE
app.post('/api/ai-summary', async (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: "ไม่พบ Group ID" });

    try {
        // ดึงงานทั้งหมดของกลุ่มนี้มา
        const { data: tasks, error } = await supabase.from('tasks').select('*').eq('group_id', groupId);
        
        if (error || !tasks || tasks.length === 0) {
            await client.pushMessage(groupId, { type: 'text', text: "ตอนนี้ยังไม่มีงานในระบบเลยเมี๊ยว~ 💤" });
            return res.json({ success: true });
        }

        // เตรียมข้อมูลป้อนให้ AI
        const taskData = tasks.map(t => 
            `- งาน: ${t.task_name} | สถานะ: ${t.status === 'done' ? 'เสร็จแล้ว✅' : 'รอทำ⏳'} | กำหนดส่ง: ${t.deadline || 'ไม่ระบุ'} | คนรับจบ: ${t.assignee || 'ยังไม่มี'}`
        ).join('\n');

        const prompt = `คุณคือ 'ขาวมณี' ผู้ช่วยแมวเหมียวสุดน่ารัก กวนนิดๆ เป็นกันเอง ช่วยสรุปรายการงานของกลุ่มนี้ให้หน่อย ให้อ่านง่ายๆ แบ่งเป็นงานที่เสร็จแล้วกับงานที่ค้างอยู่ ใช้ Emoji ประกอบด้วยนะเมี๊ยว\n\nข้อมูลงาน:\n${taskData}`;

        // เรียกใช้งาน Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        // ส่งผลลัพธ์กลับเข้ากลุ่ม LINE
        await client.pushMessage(groupId, { type: 'text', text: aiResponse });
        res.json({ success: true });

    } catch (err) {
        console.error("AI Summary Error:", err);
        res.status(500).json({ error: err.message });
    }
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
                text: `⏰ ตื่นๆ มีงานค้างวันนี้เมี๊ยว:\n${taskNames}`
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
    console.log(`🚀 ขาวมณีพร้อมในพอร์ต ${port} เมี๊ยว!`);
});