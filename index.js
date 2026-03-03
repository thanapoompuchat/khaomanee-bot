require('dotenv').config();

const express = require('express');

const line = require('@line/bot-sdk');

const { GoogleGenerativeAI } = require('@google/generative-ai');

const { createClient } = require('@supabase/supabase-js');

const cron = require('node-cron');



const app = express();

const port = process.env.PORT || 10000;



// ==========================================

// ⚙️ ตั้งค่าระบบต่างๆ

// ==========================================

const lineConfig = {

    channelAccessToken: process.env.LINE_ACCESS_TOKEN,

    channelSecret: process.env.LINE_CHANNEL_SECRET

};



const client = new line.Client(lineConfig);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);



// ==========================================

// 🟢 Webhook Middleware (ต้องอยู่ก่อน express.json)

// ==========================================

app.post('/webhook', line.middleware(lineConfig), (req, res) => {

    Promise.all(req.body.events.map(handleEvent))

        .then((result) => res.json(result))

        .catch((err) => {

            console.error('Webhook Error:', err);

            res.status(500).end();

        });

});



app.use(express.json());

app.use(express.static('public'));



// ==========================================

// 💬 ฟังก์ชันจัดการข้อความและ Event ต่างๆ

// ==========================================

async function handleEvent(event) {

    // ป้องกัน Reply Token ปลอมตอน Verify

    if (event.replyToken === '00000000000000000000000000000000' || event.replyToken === 'ffffffffffffffffffffffffffffffff') return null;

    

    const groupId = event.source.type === 'group' ? event.source.groupId : (event.source.type === 'room' ? event.source.roomId : event.source.userId);

    const baseUrl = process.env.BASE_URL || 'https://line.me'; // ใส่ fallback ป้องกัน Error



    // 🌟 ดักจับตอน "ดึงเข้ากลุ่ม" (join) หรือ "แอดเป็นเพื่อน" (follow)

    if (event.type === 'join' || event.type === 'follow') {

        const welcomeFlex = {

            type: "flex",

            altText: "สวัสดีเมี๊ยว! ขาวมณีพร้อมช่วยงานแล้ว",

            contents: {

                type: "carousel",

                contents: [

                    {

                        type: "bubble",

                        hero: {

                            type: "image",

                            url: "https://qkwsuionwswlxjilsegh.supabase.co/storage/v1/object/public/bot-assets/1.png",

                            size: "full",

                            aspectRatio: "1:1",

                            aspectMode: "cover",

                            action: {

                                type: "message",

                                label: "เรียกขาวมณี",

                                text: "ขาวมณี"

                            }

                        }

                    },

                    {

                        type: "bubble",

                        hero: {

                            type: "image",

                            url: "https://qkwsuionwswlxjilsegh.supabase.co/storage/v1/object/public/bot-assets/2.png",

                            size: "full",

                            aspectRatio: "1:1",

                            aspectMode: "cover",

                            action: {

                                type: "uri",

                                label: "กระดานงาน",

                                uri: `${baseUrl}/?groupId=${groupId}`

                            }

                        }

                    },

                    {

                        type: "bubble",

                        hero: {

                            type: "image",

                            url: "https://qkwsuionwswlxjilsegh.supabase.co/storage/v1/object/public/bot-assets/3.png",

                            size: "full",

                            aspectRatio: "1:1",

                            aspectMode: "cover",

                            action: {

                                type: "uri",

                                label: "จดงานใหม่",

                                uri: `${baseUrl}/add-task?groupId=${groupId}` 

                            }

                        }

                    }

                ]

            }

        };



        try {

            // ส่งข้อความ Text นำทางก่อน แล้วตามด้วย Flex รูปภาพล้วน

            return await client.replyMessage(event.replyToken, [

                { type: 'text', text: 'สวัสดีเมี๊ยว! ขาวมณีมาแล้วเจ้าค่ะ\nเรียกใช้ขาวมณีแค่พิมพ์ "ขาวมณี" นะเมี๊ยว!' },

                welcomeFlex

            ]);

        } catch (err) {

            console.error('Error sending Flex Message:', err.originalError?.response?.data || err);

        }

    }



    // --- ส่วนจัดการข้อความปกติพิมพ์คุยกับบอท ---

    if (event.type === 'message' && event.message.type === 'text') {

        const userText = event.message.text.trim();

        

        if (userText === 'ขาวมณี') {

            return client.replyMessage(event.replyToken, {

                type: 'text', text: 'เรียกขาวมณีมีอะไรให้ช่วยไหมเมี๊ยว?',

                quickReply: {

                    items: [

                        { type: 'action', action: { type: 'uri', label: '📋 กระดานงาน', uri: `${baseUrl}/?groupId=${groupId}` } },

                        { type: 'action', action: { type: 'uri', label: '📝 จดงานใหม่', uri: `${baseUrl}/add-task?groupId=${groupId}` } }

                    ]

                }

            });

        }

        

        // คำสั่งจดงาน AI

        if (userText.startsWith('ขาวมณีจด')) {

            const taskCommand = userText.replace('ขาวมณีจด', '').trim();

            try {

                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                const prompt = `สกัดข้อมูลงานเป็น JSON: { "taskName": "...", "assignee": "..." } จากข้อความ: "${taskCommand}"`;

                const result = await model.generateContent(prompt);

                const taskData = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

                

                await supabase.from('tasks').insert([{ 

                    task_name: taskData.taskName, assignee: taskData.assignee, status: 'todo', group_id: groupId 

                }]);

                return client.replyMessage(event.replyToken, { type: 'text', text: `📝 จดงาน "${taskData.taskName}" ให้แล้วเมี๊ยว!` });

            } catch (e) { 

                console.error(e);

                return client.replyMessage(event.replyToken, { type: 'text', text: "แง้ว! ขาวมณีงง พิมพ์ใหม่อีกทีนะเมี๊ยว" });

            }

        }

    }

}



// ==========================================

// 🌐 API Endpoints (ส่วนหลังบ้านและหน้าเว็บ)

// ==========================================

app.get('/api/tasks', async (req, res) => {

    try {

        const { groupId } = req.query;

        let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });

        if (groupId && groupId !== 'null') query = query.eq('group_id', groupId);

        const { data, error } = await query;

        if (error) throw error;

        res.json(data);

    } catch (err) { res.status(500).json({ error: err.message }); }

});



app.post('/api/add-task', async (req, res) => {

    try {

        const { taskName, description, deadline, subtasks, groupId } = req.body;

        let assigneeText = (subtasks && subtasks.length > 0) ? subtasks.map(s => `${s.name} (${s.role})`).join(', ') : 'ยังไม่แบ่งงาน';

        const { error } = await supabase.from('tasks').insert([{

            task_name: taskName, description: description || '', deadline: deadline || null, assignee: assigneeText, status: 'todo', group_id: groupId

        }]);

        if (error) throw error;

        if (groupId && groupId !== 'personal') {

            await client.pushMessage(groupId, { type: 'text', text: `📝 มีงานใหม่มาเมี๊ยว!\n📌 หัวข้อ: ${taskName}\n👥 คนทำ: ${assigneeText}` });

        }

        res.json({ success: true });

    } catch (error) { res.status(500).json({ success: false, error: error.message }); }

});



app.post('/api/update-task', async (req, res) => {

    try {

        const { id, status } = req.body;

        await supabase.from('tasks').update({ status: status }).eq('id', id);

        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }

});



app.post('/api/update-progress', async (req, res) => {

    try {

        const { id, progress_note, updater_name } = req.body;

        const { data: task } = await supabase.from('tasks').select('progress_note').eq('id', id).single();

        let history = task.progress_note ? JSON.parse(task.progress_note) : [];

        history.push({ name: updater_name || 'ไม่ระบุ', note: progress_note, date: new Date().toISOString() });

        await supabase.from('tasks').update({ progress_note: JSON.stringify(history) }).eq('id', id);

        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }

});



app.post('/api/delete-task', async (req, res) => {

    try {

        await supabase.from('tasks').delete().eq('id', req.body.id);

        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }

});



// ==========================================

// ⏰ ระบบตั้งเวลา (Cron Job) เตือนงาน 8 โมงเช้า

// ==========================================

cron.schedule('0 8 * * *', async () => {

    try {

        const { data: pendingTasks } = await supabase.from('tasks').select('*').eq('status', 'todo');

        if (!pendingTasks) return;

        const tasksByGroup = {};

        pendingTasks.forEach(t => {

            if(!tasksByGroup[t.group_id]) tasksByGroup[t.group_id] = [];

            tasksByGroup[t.group_id].push(t);

        });

        for (const [gId, tasks] of Object.entries(tasksByGroup)) {

            if(gId === 'personal' || !gId) continue; 

            const taskNames = tasks.map(t => `- ${t.task_name}`).join('\n');

            await client.pushMessage(gId, { type: 'text', text: `⏰ งานค้างวันนี้เมี๊ยว:\n${taskNames}` });

        }

    } catch (err) { console.error("Cron Error:", err); }

});



app.listen(port, () => console.log(`🚀 ขาวมณีพร้อมรับใช้ในพอร์ต ${port}`));

