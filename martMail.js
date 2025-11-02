const path = require('path');
require('node:process').loadEnvFile(path.join(__dirname, '.env'));
const fs = require('fs').promises;
const { JSDOM } = require('jsdom');
var package = require('./package.json');
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
            const communicationImage = communicationDOM.window.document.querySelector('link[rel="mask-icon"]')?.href;
            const communicationAuthor = communicationDOM.window.document.querySelector('.site-title .navbar-brand')?.textContent.replace(/\s+/g, ' ').trim();
            if (!communicationAuthor.includes('Schmidt')) continue;
            const communicationTitle = communicationDOM.window.document.querySelector('.field--name-title')?.textContent.trim();
            const communicationLinks = [];
            const communicationEmbeds = [];
            const communicationSections = Array.from(communicationDOM.window.document.querySelector('.text-formatted').children).flatMap(communicationSection => Array.from(communicationSection.innerHTML.split('<br><br>')).map(sectionHTML => {
                sectionHTML = sectionHTML.replaceAll('&nbsp;<br>\n', '').trim().replaceAll('&nbsp;<br>', '').trim().replaceAll('&nbsp;', ' ').trim();
                const section = new JSDOM(`<!DOCTYPE html>${sectionHTML}`).window.document;
                var content = '';
                switch (communicationSection.tagName.toLowerCase()) {
                    case 'ul':
                        htmlContent = Array.from(section.querySelectorAll('li')).map(li => `* ${li.innerHTML.trim()}`).join('\n').trim();
                        content = Array.from(section.querySelectorAll('li')).map(li => `* ${new JSDOM(`<!DOCTYPE html>${li.innerHTML}`).window.document.body.textContent.trim()}`).join('\n').trim();
                        break;
                    case 'ol':
                        htmlContent = Array.from(section.querySelectorAll('li')).map((li, j) => `${j + 1}. ${li.innerHTML.trim()}`).join('\n').trim();
                        content = Array.from(section.querySelectorAll('li')).map((li, j) => `${j + 1}. ${new JSDOM(`<!DOCTYPE html>${li.innerHTML}`).window.document.body.textContent.trim()}`).join('\n').trim();
                        break;
                    default:
                        htmlContent = section.body.innerHTML.replaceAll('<br>', '\n').trim();
                        content = new JSDOM(`<!DOCTYPE html>${((section.querySelector('span:has(strong)') && (section.querySelector('span:has(strong)').textContent.length < 50)) ? new JSDOM(`<!DOCTYPE html>${sectionHTML.split(section.querySelector('span:has(strong)').outerHTML)[1]}`).window.document : section).body.innerHTML.replaceAll('<br>', '\n')}`).window.document.body.textContent.trim();
                        break;
                };
                for (const [, url, innerHtml] of htmlContent.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
                    const text = innerHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                    if (url.trim().length <= 512) communicationLinks.push(text.trim().endsWith('@rpi.edu') ? { text, url: `https://faisaln.com/scripts/mart-mail/${text}`, type: 'email' } : { text, url: url.trim().replaceAll('mailto:', 'https://faisaln.com/scripts/mart-mail/'), type: url.includes('mailto') ? 'email' : 'link' });
                };
                if (sectionHTML.includes('<iframe')) {
                    for (const [, src] of sectionHTML.matchAll(/<iframe\s+[^>]*src="([^"]+)"[^>]*>/gi)) {
                        communicationLinks.push({ text: 'Watch video', url: src.trim(), type: 'video' })
                    };
                };
                if (sectionHTML.includes('<video')) {
                    for (const [, src] of sectionHTML.matchAll(/<video\s+[^>]*src="([^"]+)"[^>]*>/gi)) {
                        communicationEmbeds.push({ url: src.trim(), content_type: 'video/mp4' });
                    };
                };
                if (sectionHTML.includes('<img')) {
                    for (const [, src] of sectionHTML.matchAll(/<img\s+[^>]*src="([^"]+)"[^>]*>/gi)) {
                        communicationEmbeds.push({ url: src.trim(), content_type: 'image/png' });
                    };
                };
                return {
                    heading: (section.querySelector('span:has(strong)') && (section.querySelector('span:has(strong)').textContent.length < 50)) ? section.querySelector('span:has(strong)').textContent.trim() : null,
                    content
                };
            })).filter(section => section.content.length > 0).flatMap(section => {
                var content = section.content;
                if (content.length <= 1000) return [section];
                const parts = [];
                while (content.length > 0) {
                    var cutoff = content.lastIndexOf(' ', 1000);
                    if (cutoff === -1) cutoff = 1000;
                    const remaining = content.length - cutoff;
                    if (remaining > 0 && remaining < 30) cutoff = content.length;
                    const chunk = content.substring(0, cutoff);
                    parts.push({
                        heading: parts.length ? '' : section.heading,
                        content: content.length <= cutoff ? chunk : `${chunk}...`
                    });
                    content = content.substring(cutoff).trim();
                };
                return parts;
            }).map(communicationSection => {
                return {
                    "name": communicationSection.heading || "",
                    "value": communicationSection.content,
                    "inline": false
                };
            });
            const embed = {
                color: parseInt(communicationColor.replace('#', ''), 16),
                author: {
                    name: `President ${communicationAuthor}`,
                    url: process.env.DOMAIN,
                    icon_url: 'https://faisaln.com/Marty-Schmidt.png',
                },
                title: `${process.env.DISCORD_EMOJI ? `${process.env.DISCORD_EMOJI} ` : ''}Incoming Mail #${total - communicationsArray.indexOf(communicationItem)}: ${communicationTitle}`,
                thumbnail: { url: `${process.env.DOMAIN}${communicationImage}` },
                url: `${process.env.DOMAIN}${communicationURL}`,
                footer: {
                    text: `Mart Mail v${package.version} •${martStats.totalSent + 1} Mart Mails Sent`,
                    icon_url: 'https://faisaln.com/Mart-Mail.png',
                },
                timestamp: new Date(communicationDateTime).toISOString(),
                fields: [],
            };
            for (let k = 0; k < communicationSections.length; k++) {
                const field = {
                    name: communicationSections[k].name,
                    value: communicationSections[k].value,
                    inline: !!communicationSections[k].inline,
                };
                if ((JSON.stringify(embed).length + JSON.stringify(field).length) > 6000) {
                    const remaining = 6000 - JSON.stringify(embed).length - JSON.stringify({ name: field.name, value: '', inline: field.inline }).length;
                    if (remaining > 20) {
                        field.value = field.value.slice(0, remaining - 3) + '...';
                        embed.fields.push(field);
                    };
                    break;
                };
                embed.fields.push(field);
            };
            const imageEmbeds = communicationEmbeds.map(img => ({
                color: embed.color,
                image: { url: img.url, content_type: img.content_type },
            }));
            const embeds = [embed];
            for (const imageEmbed of imageEmbeds) {
                if ((JSON.stringify(embeds).length + JSON.stringify(imageEmbed).length) <= 6000) {
                    embeds.push(imageEmbed);
                } else {
                    embed.description += `\n[Image](${imageEmbed.image.url})`;
                };
            };
            await sendWebhook({
                "username": "Mart Mail",
                "avatar_url": "https://faisaln.com/Mart-Mail.png",
                "content": `${process.env.DISCORD_ROLE ? `${process.env.DISCORD_ROLE} ` : ''}Rejoice fellow Schmidtizens! Our beloved president has bestowed on us yet another mailed announcement! ${process.env.DISCORD_EMOJI_2 ? `${process.env.DISCORD_EMOJI_2} ` : ''}His priceless words are affixed:`,
                "embeds": embeds,
                "components": [
                    {
                        "type": 1,
                        "components": [
                            {
                                "type": 2,
                                "style": 5,
                                "emoji": process.env.DISCORD_EMOJI ? {
                                    "id": process.env.DISCORD_EMOJI.split(':')[2].replace('>', ''),
                                    "name": process.env.DISCORD_EMOJI.split(':')[1]
                                } : {
                                    "name": "🧑‍💻"
                                },
                                "url": "https://faisaln.com/scripts/mart-mail"
                            },
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
                                "label": `Read ${((communicationSections.length > 25) || (JSON.stringify(embed).length >= 5750)) ? 'the rest' : 'it online'}`,
                                "emoji": {
                                    "name": "📃"
                                },
                                "url": `${process.env.DOMAIN}${communicationURL}`
                            }
                        ],
                    },
                    ...communicationLinks.reduce((r, v, i) => ((i % 5) ? r[r.length - 1].push(v) : r.push([v]), r), []).map(linkGroup => ({
                        "type": 1,
                        "components": linkGroup.map(link => ({
                            "type": 2,
                            "style": 5,
                            "label": link.text.includes('http') ? "Open link" : ((link.text.length > 80) ? `${link.text.substring(0, 77)}...` : link.text),
                            "emoji": {
                                "name": (link.type === 'email') ? "✉️" : ((link.type === 'video') ? "📺" : "🔗")
                            },
                            "url": link.url
                        }))
                    }))
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