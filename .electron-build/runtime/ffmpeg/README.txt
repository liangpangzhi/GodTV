God TV 桌面版运行时依赖
==================================================

本目录在安装后位于：
  <安装目录>\resources\runtime\ffmpeg\

【ffmpeg.exe】
已随程序内置（静态构建 win-x64），用于「飞牛影音本地解码」功能：
  · 将 NAS 上的 MKV/TS 等浏览器无法直接解码的原片，在本机实时转封装为
    分片 MP4（-c:v copy，不重新编码，几乎不占 CPU），由本机解码播放；
  · 当原片编码浏览器也不支持时，可在本机本地转码（H.264）。

【ffprobe.exe】（可选）
如需使用「服务端 HLS 转存下载」功能，请把 ffprobe.exe 放到本目录。
基本播放、搜索、直播与飞牛本地解码均无需 ffprobe。

提示：可从 https://www.gyan.dev/ffmpeg/builds/ 或
      https://github.com/BtbN/FFmpeg-Builds/releases 获取更新版本替换。
