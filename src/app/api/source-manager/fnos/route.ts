/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import type { PrivateLibraryConnector } from '@/lib/admin.types';
import { fnTestConnector } from '@/lib/fnos-client';
import { normalizePrivateLibraryConfig } from '@/lib/private-library-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/source-manager/fnos
 * body: { connector: PrivateLibraryConnector, action: 'test' }
 * 测试飞牛影视连接是否可用（在 public 免登录模式下由 proxy 白名单放行）。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { connector, action } = body as {
      connector?: PrivateLibraryConnector;
      action?: string;
    };

    if (!connector) {
      return NextResponse.json({ error: '缺少连接器配置' }, { status: 400 });
    }

    // 强制类型为 fnos 并通过归一化校验字段
    const normalized = normalizePrivateLibraryConfig({
      connectors: [{ ...connector, type: 'fnos' }],
    }).connectors[0];

    if (!normalized) {
      return NextResponse.json({ error: '连接器配置无效' }, { status: 400 });
    }

    if (action === 'test') {
      const result = await fnTestConnector(normalized);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: '不支持的操作' }, { status: 400 });
  } catch (error) {
    console.error('[SourceManager fnOS] 操作失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
