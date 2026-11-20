/** @type {import('next').NextConfig} */

const nextConfig = {
  // 根据环境自动选择输出模式：Vercel自动处理，Docker使用standalone
  // 本地开发时不使用 standalone 避免 Windows 符号链接权限问题
  ...(process.env.VERCEL || process.env.DOCKER_BUILD
    ? { output: 'standalone' }
    : {}),

  reactStrictMode: false,

  // Next.js 16 使用 Turbopack，配置 SVG 加载
  turbopack: {
    root: __dirname,
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },

  // 性能优化：包体积优化和模块化导入
  experimental: {
    // 自动优化大型库的导入，只打包实际使用的部分
    optimizePackageImports: [
      'lucide-react',
      '@heroicons/react',
      'framer-motion',
      'react-icons',
    ],
  },

  // 图片优化配置
  images: {
    // Android TV 版使用内置服务端，bionic libc 不兼容 sharp 的 glibc 原生模块，
    // 因此在该平台关闭服务端图片优化，由浏览器直接加载原图。
    unoptimized: process.env.GODTV_ANDROID === '1',
    // NOTE: 移除 unoptimized: true 以启用 Next.js 图片优化
    // 如果部署到不支持图片优化的平台，可重新启用
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },
};

module.exports = nextConfig;
