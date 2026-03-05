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

        if (userText === 'ขาวมณี' || userText === 'จัดการงาน' || userText === 'เมนู') {
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

// 🆕 API สำหรับเพิ่มงาน (Flex Message อัปเกรด Native LINE Style ✨)
app.post('/api/add-task', async (req, res) => {
    try {
        const { taskName, description, deadline, assignee, groupId } = req.body;

        if (!taskName) {
            return res.status(400).json({ success: false });
        }

        // บันทึกงานลง Database
        const { error } = await supabase
            .from('tasks')
            .insert([{
                task_name: taskName,
                description: description || null,
                deadline: deadline || null,
                status: 'todo',
                assignee: assignee || null,
                group_id: groupId || 'personal'
            }]);

        if (error) {
            console.error(error);
            return res.status(500).json({ success: false });
        }

        // ==========================================
        // 🐾 ส่ง Flex Message แจ้งเตือนเข้ากลุ่ม LINE
        // ==========================================
        if (groupId && groupId !== 'personal') {
            try {
                // จัดสไตล์รายชื่อให้เป็นสไตล์ของแอป LINE
                const assigneeList = assignee ? assignee.split(',').map(s => s.trim()) : [];
                const assigneeContents = assigneeList.length > 0 ? assigneeList.map(item => {
                    const match = item.match(/^(.*?)\s*\(([^)]+)\)$/);
                    const name = match ? match[1] : item;
                    const role = match ? match[2] : 'ทั่วไป';
                    
                    return {
                        "type": "box",
                        "layout": "horizontal",
                        "alignItems": "flex-start",
                        "contents": [
                            {
                                "type": "box",
                                "layout": "horizontal",
                                "flex": 2,
                                "alignItems": "center",
                                "contents": [
                                    { "type": "text", "text": "🐱", "flex": 0, "size": "sm", "margin": "none" },
                                    { "type": "text", "text": name, "size": "sm", "color": "#111111", "weight": "bold", "margin": "md", "wrap": true }
                                ]
                            },
                            { "type": "text", "text": role, "size": "xs", "color": "#888888", "align": "end", "flex": 1, "margin": "sm", "offsetTop": "2px" }
                        ]
                    };
                }) : [
                    {
                        "type": "box",
                        "layout": "horizontal",
                        "contents": [
                            { "type": "text", "text": "ยังไม่มีคนรับจบ 😿", "size": "sm", "color": "#bbbbbb", "align": "start", "weight": "bold" }
                        ]
                    }
                ];

                const flexMessage = {
                    "type": "flex",
                    "altText": `✨ มีงานใหม่เข้ามา: ${taskName}`,
                    "contents": {
                        "type": "bubble",
                        "size": "mega",
                        "body": {
                            "type": "box",
                            "layout": "vertical",
                            "paddingAll": "0px",
                            "contents": [
                                // Header โทนสีละมุน และเว้นที่เผื่อแมว
                                {
                                    "type": "box",
                                    "layout": "vertical",
                                    "paddingAll": "24px",
                                    "paddingTop": "28px",
                                    "background": {
                                        "type": "linearGradient",
                                        "angle": "135deg",
                                        "startColor": "#fdf2f8", 
                                        "endColor": "#fce7f3"    
                                    },
                                    "contents": [
                                        { "type": "text", "text": "✨ มีงานใหม่เข้ามาเมี๊ยว!", "weight": "bold", "color": "#e11d48", "size": "xs" },
                                        { "type": "text", "text": taskName, "weight": "bold", "size": "xxl", "color": "#111111", "wrap": true, "margin": "md", "flex": 1, "maxWidth": "75%" },
                                        { "type": "text", "text": description || "ไม่มีรายละเอียด", "size": "sm", "color": "#666666", "wrap": true, "margin": "md", "maxWidth": "85%" },
                                        
                                        // กล่องเดดไลน์ คลีนๆ
                                        {
                                            "type": "box",
                                            "layout": "horizontal",
                                            "margin": "xl",
                                            "backgroundColor": "#ffffffcc",
                                            "cornerRadius": "lg",
                                            "paddingAll": "10px",
                                            "paddingStart": "14px",
                                            "paddingEnd": "14px",
                                            "alignItems": "center",
                                            "contents": [
                                                { "type": "text", "text": "⏰ เดดไลน์:", "size": "xs", "color": "#555555", "weight": "bold", "flex": 0 },
                                                { "type": "text", "text": deadline || "ไม่ระบุ", "size": "xs", "color": "#e11d48", "weight": "bold", "margin": "md" }
                                            ]
                                        }
                                    ]
                                },
                                // รูปแมวเล่นมุมขวาบน
                                {
                                    "type": "image",
                                    "url": "https://qkwsuionwswlxjilsegh.supabase.co/storage/v1/object/public/bot-assets/4.png",
                                    "position": "absolute",
                                    "align": "end",
                                    "offsetTop": "0px",
                                    "offsetEnd": "-10px", // ดันออกขวาไปนิดนึงให้ดูเหมือนแอบโผล่มา
                                    "size": "xl", // ปรับขนาดให้ใหญ่ขึ้น
                                    "aspectMode": "fit"
                                },
                                // กล่องคนทำงานสีขาวล้วน
                                {
                                    "type": "box",
                                    "layout": "vertical",
                                    "paddingAll": "24px",
                                    "backgroundColor": "#ffffff",
                                    "contents": [
                                        {
                                            "type": "box",
                                            "layout": "horizontal",
                                            "paddingBottom": "10px",
                                            "contents": [
                                                { "type": "text", "text": "รายชื่อคนรับจบ", "size": "xs", "color": "#aaaaaa", "weight": "bold", "flex": 2 },
                                                { "type": "text", "text": "หน้าที่", "size": "xs", "color": "#aaaaaa", "weight": "bold", "align": "end", "flex": 1 }
                                            ]
                                        },
                                        { "type": "separator", "color": "#f0f0f0" },
                                        {
                                            "type": "box",
                                            "layout": "vertical",
                                            "margin": "md",
                                            "spacing": "sm",
                                            "contents": assigneeContents
                                        }
                                    ]
                                }
                            ]
                        },
                        "footer": {
                            "type": "box",
                            "layout": "vertical",
                            "paddingAll": "24px",
                            "paddingTop": "0px",
                            "contents": [
                                {
                                    "type": "button",
                                    "action": {
                                        "type": "uri",
                                        "label": "ดูรายละเอียด 🐾",
                                        "uri": `${BASE_URL}/?groupId=${groupId}`
                                    },
                                    "style": "primary",
                                    "color": "#f43f5e",
                                    "height": "sm"
                                }
                            ]
                        }
                    }
                };

                await client.pushMessage(groupId, flexMessage);
            } catch (flexError) {
                console.error('ส่ง Flex Message ไม่สำเร็จ:', flexError);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Add task error:', err);
        res.status(500).json({ success: false });
    }
});

// API อัปเดตสถานะงาน
app.post('/api/update-task', async (req, res) => {
    const { id, status } = req.body;
    const { error } = await supabase.from('tasks').update({ status }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// API อัปเดตความคืบหน้า
app.post('/api/update-progress', async (req, res) => {
    const { id, progress_note, updater_name } = req.body;
    const { error } = await supabase.from('tasks').update({ 
        progress_note: progress_note,
        assignee: updater_name 
    }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// API ลบงาน
app.post('/api/delete-task', async (req, res) => {
    const { id } = req.body;
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// API AI สรุปงาน
app.post('/api/ai-summary', async (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: "ไม่พบ Group ID" });

    try {
        const { data: tasks, error } = await supabase.from('tasks').select('*').eq('group_id', groupId);
        
        if (error || !tasks || tasks.length === 0) {
            await client.pushMessage(groupId, { type: 'text', text: "ตอนนี้ยังไม่มีงานในระบบเลยเมี๊ยว~ 💤" });
            return res.json({ success: true });
        }

        const taskData = tasks.map(t => 
            `- งาน: ${t.task_name} | สถานะ: ${t.status === 'done' ? 'เสร็จแล้ว✅' : 'รอทำ⏳'} | กำหนดส่ง: ${t.deadline || 'ไม่ระบุ'} | คนรับจบ: ${t.assignee || 'ยังไม่มี'}`
        ).join('\n');

        const prompt = `คุณคือ 'ขาวมณี' ผู้ช่วยแมวเหมียวสุดน่ารัก กวนนิดๆ เป็นกันเอง ช่วยสรุปรายการงานของกลุ่มนี้ให้หน่อย ให้อ่านง่ายๆ แบ่งเป็นงานที่เสร็จแล้วกับงานที่ค้างอยู่ ใช้ Emoji ประกอบด้วยนะเมี๊ยว\n\nข้อมูลงาน:\n${taskData}`;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

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