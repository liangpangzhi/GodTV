/**
 * 预置源配置（构建时注入）
 * 来源: niubihu1/tvbox 配置，已转换为 God TV 配置格式
 * 包含 22 个苹果 CMS V10 点播源与 9 个公开直播源
 */

import type { AdminConfig } from './admin.types';
import type { ApiSite, LiveCfg } from './config';

// God TV 配置文件格式（与后台“配置文件”导入一致）
export const PRESET_CONFIG_FILE =
  '{"api_site":{"bfzy_暴风":{"name":"🌪️┃暴风┃采集","api":"https://bfzyapi.com/api.php/provide/vod/"},"hongniu_红牛":{"name":"🐂┃红牛┃采集","api":"https://www.hongniuzy2.com/api.php/provide/vod/"},"lziapi_量子":{"name":"🥑┃量子┃采集","api":"https://cj.lziapi.com/api.php/provide/vod/"},"ffzy_非凡":{"name":"🥗┃非凡┃采集","api":"http://cj.ffzyapi.com/api.php/provide/vod/"},"huya_虎牙采集":{"name":"🐯虎牙┃采集","api":"https://www.huyaapi.com/api.php/provide/vod/"},"wujin_无尽":{"name":"♾️┃无尽┃采集","api":"https://api.wujinapi.com/api.php/provide/vod/"},"vod_光速":{"name":"雷蒙影视 | 🚀光速","api":"https://api.guangsuapi.com/api.php/provide/vod/from/gsm3u8/"},"ruyi":{"name":"如意资源","api":"https://cj.rycjapi.com/api.php/provide/vod/"},"vod_魔都":{"name":"雷蒙影视 | ️🚀魔都","api":"https://www.moduzy.com/api.php/provide/vod/"},"速博资源":{"name":"速博资源","api":"https://subocaiji.com/api.php/provide/vod/"},"西瓜资源":{"name":"西瓜资源","api":"https://xiguazy.tv/api.php/provide/vod/"},"大众影视":{"name":"大众影视","api":"https://cdn.dzzyapi.com/api.php/provide/vod/"},"淘片资源":{"name":"❤淘片资源","api":"https://taopianapi.com/cjapi/mc/vod/json.html"},"csp_xml_ikun":{"name":"❤ikun资源","api":"https://ikunzyapi.com/api.php/provide/vod/from/ikm3u8/at/json"},"zy360":{"name":"360资源","api":"https://360zy.com/api.php/provide/vod/"},"csp_xml_新浪":{"name":"❤新浪资源","api":"https://api.xinlangapi.com/xinlangapi.php/provide//vod/"},"U酷资源風":{"name":"影视 • 尤酷[直连]","api":"https://api.ukuapi.com/api.php/provide/vod/"},"csp_xml_优质":{"name":"❤优质资源","api":"https://api.1080zyku.com/inc/api_mac10.php"},"猫眼资源":{"name":"猫眼资源","api":"https://api.maoyanapi.top/api.php/provide/vod"},"极速资源":{"name":"影视 • 极速[直连]","api":"https://jszyapi.com/api.php/provide/vod/"},"金鹰采集":{"name":"🍁金鹰采集🍁|cdn2020","api":"https://jyzyapi.com/provide/vod/"},"建安采集":{"name":"影视 | 建安","api":"http://154.219.117.232:9981/jacloudapi.php/provide/vod"}},"lives":{"🐯牛虎 ┃ 官方综合":{"name":"🐯牛虎 ┃ 官方综合","url":"https://gh-proxy.com/https://raw.githubusercontent.com/niubihu1/tvbox/main/live.txt","ua":"okhttp/3.15","epg":"http://epg.112114.xyz/?ch={name}&date={date}"},"🍚饭太硬 ┃ 精选频道":{"name":"🍚饭太硬 ┃ 精选频道","url":"https://nos.netease.com/ysf/3d75a78a0fc7ede372c03598d6d10367.m3u","ua":"okhttp/3.15"},"🐎小马综合 ┃ 高清直播":{"name":"🐎小马综合 ┃ 高清直播","url":"https://szyyds.cn/tv/live/x.txt","ua":"okhttp/3.15","epg":"http://epg.112114.xyz/?ch={name}&date={date}"},"📡自动更新 ┃ 全国电视":{"name":"📡自动更新 ┃ 全国电视","url":"https://z.szyyds.cn/iptv","ua":"okhttp/3.15"},"🎵音乐台 ┃ 现场MV":{"name":"🎵音乐台 ┃ 现场MV","url":"https://szyyds.cn/tv/live/yy.txt","ua":"okhttp/3.15"},"🐯虎牙 ┃ 一起看公网":{"name":"🐯虎牙 ┃ 一起看公网","url":"https://sub.ottiptv.cc/huyayqk.m3u","ua":"okhttp/3.15"},"📺EasyTV ┃ 熵侦卫视":{"name":"📺EasyTV ┃ 熵侦卫视","url":"https://easyzz.dpdns.org/api/tv.png"},"🌐Guovin ┃ 全网聚合":{"name":"🌐Guovin ┃ 全网聚合","url":"https://cdn.jsdelivr.net/gh/Guovin/iptv-api@gd/output/result.txt","ua":"okhttp/3.15"},"🐟斗鱼 ┃ 一起看公网":{"name":"🐟斗鱼 ┃ 一起看公网","url":"https://sub.ottiptv.cc/douyuyqk.m3u","ua":"okhttp/3.15"}},"cache_time":7200}';

interface PresetParsed {
  api_site?: {
    [key: string]: {
      name: string;
      api: string;
      detail?: string;
      is_adult?: boolean;
    };
  };
  lives?: {
    [key: string]: { name: string; url: string; ua?: string; epg?: string };
  };
}

function parsePreset(): PresetParsed {
  try {
    return JSON.parse(PRESET_CONFIG_FILE) as PresetParsed;
  } catch {
    return {};
  }
}

/** 预置点播源（SourceConfig 片段） */
export function getPresetSources(): Pick<
  AdminConfig,
  'SourceConfig'
>['SourceConfig'] {
  const parsed = parsePreset();
  return Object.entries(parsed.api_site || {}).map(([key, site]) => ({
    key,
    name: site.name,
    api: site.api,
    detail: site.detail,
    is_adult: site.is_adult || false,
    from: 'config' as const,
    disabled: false,
  }));
}

/** 预置直播源（LiveConfig 片段） */
export function getPresetLives(): NonNullable<AdminConfig['LiveConfig']> {
  const parsed = parsePreset();
  return Object.entries(parsed.lives || {}).map(([key, live]) => ({
    key,
    name: live.name,
    url: live.url,
    ua: live.ua,
    epg: live.epg,
    channelNumber: 0,
    from: 'config' as const,
    disabled: false,
  }));
}

/** 预置 ApiSite / LiveCfg（供需要原始类型的调用方使用） */
export const PRESET_API_SITES: ApiSite[] = Object.entries(
  parsePreset().api_site || {},
).map(([key, site]) => ({
  key,
  name: site.name,
  api: site.api,
  detail: site.detail,
  is_adult: site.is_adult || false,
}));

export const PRESET_LIVE_CFG: LiveCfg[] = Object.entries(
  parsePreset().lives || {},
).map(([, live]) => ({
  name: live.name,
  url: live.url,
  ua: live.ua,
  epg: live.epg,
}));
