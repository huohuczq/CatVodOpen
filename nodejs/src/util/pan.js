import req from './req.js';
import { MAC_UA, formatPlayUrl } from './misc.js';
import * as HLS from 'hls-parser';
import * as Ali from './ali.js';
import * as Quark from './quark.js';
import dayjs from 'dayjs';

export const ua = MAC_UA;
export const Qpic = 'https://img.omii.top/i/2024/03/17/vqmr8m.webp';
export const Apic = 'https://img.omii.top/i/2024/03/17/vqn6em.webp';

function conversion(bytes){
  let mb = bytes / (1024 * 1024);
  if(mb > 1024){
    return `${(mb/1024).toFixed(2)}GB`;
    }else{
        return `${parseInt(mb).toFixed(0)}MB`;
    }
}


export function isEmpty(value) {
  if (value === null || value === undefined) {
    return true;
  } else if (typeof value === 'string') {
    return value.length === 0;
  } else if (Array.isArray(value)) {
    return value.length === 0;
  } else {
    return false;
  }
}

export async function init(inReq, _outResp) {
    await Ali.initAli(inReq.server.db, inReq.server.config.ali);
    await Quark.initQuark(inReq.server.db, inReq.server.config.quark);
    return{};
}

export async function detail0(shareUrls ,vod) {
        shareUrls = !Array.isArray(shareUrls) ? [shareUrls] : shareUrls;
        const froms = [];
        const urls = [];
        for (const shareUrl of shareUrls) {
            const shareData = Ali.getShareData(shareUrl);
            if (shareData) {
                const videos = await Ali.getFilesByShareUrl(shareData);
                if (videos.length > 0) {
                    froms.push('阿里云盘-' + shareData.shareId);
                    urls.push(
                        videos
                            .map((v) => {
                                const ids = [v.share_id, v.file_id, v.subtitle ? v.subtitle.file_id : ''];
                                const size = conversion(v.size);
                                return formatPlayUrl('', ` ${v.name.replace(/.[^.]+$/,'')}  [${size}]`) + '$' + ids.join('*');
                            })
                            .join('#'),
                    );
                }
            } else {
                const shareData = Quark.getShareData(shareUrl);
                if (shareData) {
                    const videos = await Quark.getFilesByShareUrl(shareData);
                    if (videos.length > 0) {
                        froms.push('夸克网盘-'  + shareData.shareId);
                        urls.push(
                            videos
                                .map((v) => {
                                    const ids = [shareData.shareId, v.stoken, v.fid, v.share_fid_token, v.subtitle ? v.subtitle.fid : '', v.subtitle ? v.subtitle.share_fid_token : ''];
                                    const size = conversion(v.size);
                                    return formatPlayUrl('', ` ${v.file_name.replace(/.[^.]+$/,'')}  [${size}]`) + '$' + ids.join('*');
                                })
                                .join('#'),
                        );
                    }
                }
            }
        }
        vod.vod_play_from = froms.join('$$$');
        vod.vod_play_url = urls.join('$$$');
        return vod;
}

const aliTranscodingCache = {};
const aliDownloadingCache = {};

const quarkTranscodingCache = {};
const quarkDownloadingCache = {};

export async function proxy(inReq, _outResp) {
    await Ali.initAli(inReq.server.db, inReq.server.config.ali);
    await Quark.initQuark(inReq.server.db, inReq.server.config.quark);
    const site = inReq.params.site;
    const what = inReq.params.what;
    const shareId = inReq.params.shareId;
    const fileId = inReq.params.fileId;
    if (site == 'ali') {
        if (what == 'trans') {
            const flag = inReq.params.flag;
            const end = inReq.params.end;

            if (aliTranscodingCache[fileId]) {
                const purl = aliTranscodingCache[fileId].filter((t) => t.template_id.toLowerCase() == flag)[0].url;
                if (parseInt(purl.match(/x-oss-expires=(\d+)/)[1]) - dayjs().unix() < 15) {
                    delete aliTranscodingCache[fileId];
                }
            }

            if (aliTranscodingCache[fileId] && end.endsWith('.ts')) {
                const transcoding = aliTranscodingCache[fileId].filter((t) => t.template_id.toLowerCase() == flag)[0];
                if (transcoding.plist) {
                    const tsurl = transcoding.plist.segments[parseInt(end.replace('.ts', ''))].suri;
                    if (parseInt(tsurl.match(/x-oss-expires=(\d+)/)[1]) - dayjs().unix() < 15) {
                        delete aliTranscodingCache[fileId];
                    }
                }
            }

            if (!aliTranscodingCache[fileId]) {
                const transcoding = await Ali.getLiveTranscoding(shareId, fileId);
                aliTranscodingCache[fileId] = transcoding;
            }

            const transcoding = aliTranscodingCache[fileId].filter((t) => t.template_id.toLowerCase() == flag)[0];
            if (!transcoding.plist) {
                const resp = await req.get(transcoding.url, {
                    headers: {
                        'User-Agent': MAC_UA,
                    },
                });
                transcoding.plist = HLS.parse(resp.data);
                for (const s of transcoding.plist.segments) {
                    if (!s.uri.startsWith('http')) {
                        s.uri = new URL(s.uri, transcoding.url).toString();
                    }
                    s.suri = s.uri;
                    s.uri = s.mediaSequenceNumber.toString() + '.ts';
                }
            }

            if (end.endsWith('.ts')) {
                _outResp.redirect(transcoding.plist.segments[parseInt(end.replace('.ts', ''))].suri);
                return;
            } else {
                const hls = HLS.stringify(transcoding.plist);
                let hlsHeaders = {
                    'content-type': 'audio/x-mpegurl',
                    'content-length': hls.length.toString(),
                };
                _outResp.code(200).headers(hlsHeaders);
                return hls;
            }
        } else {
            const flag = inReq.params.flag;
            if (aliDownloadingCache[fileId]) {
                const purl = aliDownloadingCache[fileId].url;
                if (parseInt(purl.match(/x-oss-expires=(\d+)/)[1]) - dayjs().unix() < 15) {
                    delete aliDownloadingCache[fileId];
                }
            }
            if (!aliDownloadingCache[fileId]) {
                const down = await Ali.getDownload(shareId, fileId, flag == 'down');
                aliDownloadingCache[fileId] = down;
            }
            _outResp.redirect(aliDownloadingCache[fileId].url);
            return;
        }
    } else if (site == 'quark') {
        let downUrl = '';
        const ids = fileId.split('*');
        const flag = inReq.params.flag;
        if (what == 'trans') {
            if (!quarkTranscodingCache[ids[1]]) {
                quarkTranscodingCache[ids[1]] = (await Quark.getLiveTranscoding(shareId, decodeURIComponent(ids[0]), ids[1], ids[2])).filter((t) => t.accessable);
            }
            downUrl = quarkTranscodingCache[ids[1]].filter((t) => t.resolution.toLowerCase() == flag)[0].video_info.url;
            _outResp.redirect(downUrl);
            return;
        } else {
            if (!quarkDownloadingCache[ids[1]]) {
                const down = await Quark.getDownload(shareId, decodeURIComponent(ids[0]), ids[1], ids[2], flag == 'down');
                if (down) quarkDownloadingCache[ids[1]] = down;
            }
            downUrl = quarkDownloadingCache[ids[1]].download_url;
            if (flag == 'redirect') {
                _outResp.redirect(downUrl);
                return;
            }
        }
        return await Quark.chunkStream(
            inReq,
            _outResp,
            downUrl,
            ids[1],
            Object.assign(
                {
                    Cookie: Quark.cookie,
                },
                Quark.baseHeader,
            ),
        );
    }
}

export async function play(inReq, _outResp) {
    const flag = inReq.body.flag;
    const id = inReq.body.id;
    const ids = id.split('*');
    let idx = 0;
    if (flag.startsWith('阿里云盘')) {
        const transcoding = await Ali.getLiveTranscoding(ids[0], ids[1]);
        aliTranscodingCache[ids[1]] = transcoding;
        transcoding.sort((a, b) => b.template_width - a.template_width);
        const p= ['超清','高清','标清','普画','极速'];
        const arr =['QHD','FHD','HD','SD','LD'];
        const urls = [];
        const proxyUrl = inReq.server.address().url + inReq.server.prefix + '/proxy/ali';
        urls.push('原画');
        urls.push(`${proxyUrl}/src/down/${ids[0]}/${ids[1]}/.bin`);
        const result = {
            parse: 0,
            url: urls,
        };
        if (ids[2]) {
            result.extra = {
                subt: `${proxyUrl}/src/subt/${ids[0]}/${ids[2]}/.bin`,
            };
        }
        transcoding.forEach((t) => {
            idx = arr.indexOf(t.template_id);
            urls.push(p[idx]);
            urls.push(`${proxyUrl}/trans/${t.template_id.toLowerCase()}/${ids[0]}/${ids[1]}/.m3u8`);
        });
        return result;
    } else if (flag.startsWith('夸克网盘')) {
        const transcoding = (await Quark.getLiveTranscoding(ids[0], ids[1], ids[2], ids[3])).filter((t) => t.accessable);
        quarkTranscodingCache[ids[2]] = transcoding;
        const urls = [];
        const p= ['超清','蓝光','高清','标清','普画','极速'];
        const arr =['4k','2k','super','high','low','normal'];
        const proxyUrl = inReq.server.address().url + inReq.server.prefix + '/proxy/quark';
        urls.push('代理');
        urls.push(`${proxyUrl}/src/down/${ids[0]}/${encodeURIComponent(ids[1])}*${ids[2]}*${ids[3]}/.bin`);
        /*urls.push('原画');
        urls.push(`${proxyUrl}/src/redirect/${ids[0]}/${encodeURIComponent(ids[1])}*${ids[2]}*${ids[3]}/.bin`);*/
        const result = {
            parse: 0,
            url: urls,
            header: Object.assign(
                {
                    Cookie: Quark.cookie,
                },
                Quark.baseHeader,
            ),
        };
        if (ids[3]) {
            result.extra = {
                subt: `${proxyUrl}/src/subt/${ids[0]}/${encodeURIComponent(ids[1])}*${ids[4]}*${ids[5]}/.bin`,
            };
        }
        transcoding.forEach((t) => {
            idx = arr.indexOf(t.resolution);
            urls.push(p[idx]);
            urls.push(`${proxyUrl}/trans/${t.resolution.toLowerCase()}/${ids[0]}/${encodeURIComponent(ids[1])}*${ids[2]}*${ids[3]}/.mp4`);
        });
        return result;
    }
}

export async function test(inReq, outResp) {
    try {
        const prefix = inReq.server.prefix;
        const dataResult = {};
        let resp = await inReq.server.inject().post(`${prefix}/init`);
        dataResult.init = resp.json();
        printErr(resp.json());
        resp = await inReq.server.inject().post(`${prefix}/home`);
        dataResult.home = resp.json();
        printErr(resp.json());
        let detailCalled = false;
        if (dataResult.home.class && dataResult.home.class.length > 0) {
            const typeId = dataResult.home.class[0].type_id;
            let filters = {};
            if (dataResult.home.filters) {
                let filter = dataResult.home.filters[typeId];
                if (filter) {
                    for (const filterCfg of filter) {
                        const initValue = filterCfg.init;
                        if (!initValue) continue;
                        for (const value of filterCfg.value) {
                            if (value.v == initValue) {
                                filters[filterCfg.key] = initValue;
                                break;
                            }
                        }
                    }
                }
            }
            resp = await inReq.server.inject().post(`${prefix}/category`).payload({
                id: typeId,
                page: 1,
                filter: true,
                filters: filters,
            });
            dataResult.category = resp.json();
            printErr(resp.json());
            if (dataResult.category.list.length > 0) {
                detailCalled = true;
                const vodId = dataResult.category.list[0].vod_id;
                await detailTest(inReq, vodId, dataResult);
            }
        }
        resp = await inReq.server.inject().post(`${prefix}/search`).payload({
            wd: '仙逆',
            page: 1,
        });
        dataResult.search = resp.json();
        if (!detailCalled && dataResult.search.list.length > 0) {
            const vodId = dataResult.search.list[0].vod_id;
            await detailTest(inReq, vodId, dataResult);
        }
        printErr(resp.json());
        return dataResult;
    } catch (err) {
        console.error(err);
        outResp.code(500);
        return { err: err.message, tip: 'check debug console output' };
    }
}

async function detailTest(inReq, vodId, dataResult) {
    const prefix = inReq.server.prefix;
    let resp = await inReq.server.inject().post(`${prefix}/detail`).payload({
        id: vodId,
    });
    dataResult.detail = resp.json();
    printErr(resp.json());
    if (dataResult.detail.list && dataResult.detail.list.length > 0) {
        dataResult.play = [];
        for (const vod of dataResult.detail.list) {
            const flags = vod.vod_play_from.split('$$$');
            const ids = vod.vod_play_url.split('$$$');
            for (let j = 0; j < flags.length; j++) {
                const flag = flags[j];
                const urls = ids[j].split('#');
                for (let i = 0; i < urls.length && i < 2; i++) {
                    resp = await inReq.server
                        .inject()
                        .post(`${prefix}/play`)
                        .payload({
                            flag: flag,
                            id: urls[i].split('$')[1],
                        });
                    dataResult.play.push(resp.json());
                }
            }
        }
    }
}

function printErr(json) {
    if (json.statusCode && json.statusCode == 500) {
        console.error(json);
    }
}