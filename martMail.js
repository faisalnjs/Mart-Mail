require('node:process').loadEnvFile();
const fs = require('fs').promises;
const path = require('path');
const { JSDOM } = require('jsdom');
var martStats = require('./martStats.json');

async function updateMartStats(field, value) {
    const file = path.resolve(__dirname, 'martStats.json');
    const raw = await fs.readFile(file, 'utf8');
    var stats = JSON.parse(raw);
    stats[field] = (field === 'totalSent') ? (stats.totalSent || 0) + 1 : value;
    await fs.writeFile(file, JSON.stringify(stats, null, 2), 'utf8');
    delete require.cache[require.resolve('./martStats.json')];
    martStats = require('./martStats.json');
};

async function sendWebhook(params) {
    for (var attempt = 0; attempt <= 3; attempt++) {
        const webhook = await fetch(`${process.env.DISCORD_WEBHOOK_URL}?with_components=true`, {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        }).catch(err => { throw err; });
        if (webhook.ok) return;
        if (webhook.status === 429) {
            const retryAfter = webhook.headers.get('retry-after');
            const wait = retryAfter ? (isNaN(Number(retryAfter)) ? (parseFloat(retryAfter) * 1000) : (Number(retryAfter) * 1000)) : 5000;
            await delay(wait);
            continue;
        };
        if (webhook.status >= 500 && attempt < 3) {
            await delay(1000 * Math.pow(2, attempt));
            continue;
        };
        const txt = await webhook.text().catch(() => '');
        console.error('Webhook failed:', JSON.stringify(params));
        throw new Error(`Webhook failed: ${webhook.status} ${webhook.statusText} ${txt}`);
    };
    throw new Error('Webhook failed to be sent');
};

async function martMail() {
    try {
        const communicationsHTML = await fetch(`${process.env.DOMAIN}/communications`);
        const communicationsText = await communicationsHTML.text();
        const communicationsDOM = new JSDOM(communicationsText);
        const communications = communicationsDOM.window.document.querySelectorAll('.my-4.pb-4.border-bottom');
        const total = Array.from(communications).length;
        await updateMartStats('total', total);
        const communicationsArray = Array.from(communications);
        const toSend = communicationsArray.filter(item => {
            const dateTime = item.querySelector('time')?.getAttribute('datetime');
            return dateTime && new Date(dateTime) > new Date(martStats.lastSent);
        }).sort((a, b) => new Date(a.querySelector('time')?.getAttribute('datetime')) - new Date(b.querySelector('time')?.getAttribute('datetime')));
        var lastSentDateSent = null;
        for (var i = 0; i < toSend.length; i++) {
            const communicationItem = toSend[i];
            const communicationDateTime = communicationItem.querySelector('time')?.getAttribute('datetime');
            const communicationURL = communicationItem.querySelector('a')?.getAttribute('href');
            console.log(`Sending Mart Mail #${total - communicationsArray.indexOf(communicationItem)}${(total - communicationsArray.indexOf(communicationItem) != total) ? `/${total}` : ''} - ${new Date(communicationDateTime)}`);
            const communicationHTML = await fetch(`${process.env.DOMAIN}${communicationURL}`);
            const communicationText = await communicationHTML.text();
            const communicationDOM = new JSDOM(communicationText);
            const communicationColor = communicationDOM.window.document.querySelector('meta[name="msapplication-TileColor"]')?.getAttribute('content')?.trim();
            const communicationImage = communicationDOM.window.document.querySelector('.navbar-brand img')?.src;
            const communicationAuthor = communicationDOM.window.document.querySelector('.site-title .navbar-brand')?.textContent.replace(/\s+/g, ' ').trim();
            if (!communicationAuthor.includes('Schmidt')) continue;
            const communicationTitle = communicationDOM.window.document.querySelector('.field--name-title')?.textContent.trim();
            const communicationSections = Array.from(communicationDOM.window.document.querySelector('.text-formatted').children).flatMap(communicationSection => Array.from(communicationSection.innerHTML.split('<br><br>')).map(sectionHTML => {
                const section = new JSDOM(`<!DOCTYPE html>${sectionHTML}`).window.document;
                var content = '';
                switch (communicationSection.tagName.toLowerCase()) {
                    case 'ul':
                        content = Array.from(section.querySelectorAll('li')).map(li => `* ${li.textContent.trim()}`).join('\n').trim();
                        break;
                    case 'ol':
                        content = Array.from(section.querySelectorAll('li')).map((li, j) => `${j + 1}. ${li.textContent.trim()}`).join('\n').trim();
                        break;
                    default:
                        content = new JSDOM(`<!DOCTYPE html>${((section.querySelector('span:has(strong)') && (section.querySelector('span:has(strong)').textContent.length < 50)) ? new JSDOM(`<!DOCTYPE html>${sectionHTML.split(section.querySelector('span:has(strong)').outerHTML)[1]}`).window.document : section).body.innerHTML.replaceAll('<br>', '\n')}`).window.document.body.textContent.trim();
                        break;
                };
                return {
                    heading: (section.querySelector('span:has(strong)') && (section.querySelector('span:has(strong)').textContent.length < 50)) ? section.querySelector('span:has(strong)').textContent.trim() : null,
                    content
                };
            })).filter(section => section.content.length > 0).flatMap(section => {
                var parts = [];
                var content = section.content;
                if (content.length <= 1000) {
                    return [section];
                } else {
                    while (content.length > 0) {
                        var cutoff = Math.min(content.lastIndexOf(' ', 1000), 1000);
                        if (cutoff === -1) cutoff = 1000;
                        parts.push({
                            heading: parts.length ? '' : section.heading,
                            content: (content.length <= cutoff) ? content.substring(0, cutoff) : `${content.substring(0, cutoff)}...`
                        });
                        content = content.substring(cutoff).trim();
                        if (content.length < 250) break;
                    };
                    return parts;
                };
            }).map(communicationSection => {
                return {
                    "name": communicationSection.heading || "",
                    "value": communicationSection.content,
                    "inline": false
                };
            });
            await sendWebhook({
                "username": "Mart Mail",
                "avatar_url": "https://faisaln.com/Mart-Mail.png",
                "content": "<@905990944858451988>",
                "embeds": [
                    {
                        "color": parseInt(communicationColor.replace('#', ''), 16),
                        "author": {
                            "name": `President ${communicationAuthor}`,
                            "url": process.env.DOMAIN,
                            "icon_url": "https://faisaln.com/Marty-Schmidt.png"
                        },
                        "description": "Rejoice fellow Schmidtizens! Our beloved president has bestowed on us yet another mailed announcement! His priceless words are affixed:\n\n--------------------------",
                        "title": `Incoming Mail #${total - communicationsArray.indexOf(communicationItem)}: ${communicationTitle}`,
                        "thumbnail": {
                            "url": `${process.env.DOMAIN}${communicationImage}`
                        },
                        "fields": (communicationSections.length > 25) ? [
                            ...communicationSections.slice(0, 24),
                            {
                                "name": "",
                                "value": `--------------------------\nRead the next ${communicationSections.length - 25} paragraph${((communicationSections.length - 25) > 1) ? 's' : ''} below:`,
                                "inline": false
                            }
                        ] : communicationSections.slice(0, 25),
                        "url": `${process.env.DOMAIN}${communicationURL}`,
                        "footer": {
                            "text": "Mart Mail - Official Marty Schmidt Fanclub",
                            "icon_url": "https://faisaln.com/Mart-Mail.png"
                        },
                        "timestamp": new Date(communicationDateTime).toISOString()
                    }
                ],
                "components": [
                    {
                        "type": 1,
                        "components": [
                            {
                                "type": 2,
                                "style": 5,
                                "label": "All Mart Mails",
                                "emoji": {
                                    "name": "📰"
                                },
                                "url": `${process.env.DOMAIN}/communications`
                            },
                            {
                                "type": 2,
                                "style": 5,
                                "label": `Read ${(communicationSections.length > 25) ? 'the rest' : 'it online'}`,
                                "emoji": {
                                    "name": "📃"
                                },
                                "url": `${process.env.DOMAIN}${communicationURL}`
                            }
                        ],
                        "accessory": {
                            "type": 11,
                            "media": {
                                "url": `${process.env.DOMAIN}${communicationImage}`
                            }
                        }
                    },
                ],
                "attachments": []
            });
            await updateMartStats('totalSent', 1);
            lastSentDateSent = communicationDateTime;
            await new Promise(resolve => setTimeout(resolve, 1500));
            console.log(`Sent Mart Mail #${total - communicationsArray.indexOf(communicationItem)}${(total - communicationsArray.indexOf(communicationItem) != total) ? `/${total}` : ''} - ${new Date(communicationDateTime)}`);
        };
        if (lastSentDateSent) await updateMartStats('lastSent', lastSentDateSent);
    } catch (error) {
        console.error("Error in martMail:", error);
    };
};

martMail();