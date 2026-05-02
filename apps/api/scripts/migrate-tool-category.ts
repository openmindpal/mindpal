#!/usr/bin/env node
/**
 * 迁移脚本：执行工具分类和优先级数据库迁移
 * 
 * 使用方法:
 *   npm run migrate:tool-category
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

async function main() {
  console.log('🚀 开始执行工具分类和优先级数据库迁移...\n');

  const migrationFile = path.join(__dirname, '../migrations/029_tool_category_priority.sql');
  
  // 检查迁移文件是否存在
  try {
    await fs.access(migrationFile);
    console.log('✅ 迁移文件存在:', migrationFile);
  } catch {
    console.error('❌ 迁移文件不存在:', migrationFile);
    process.exit(1);
  }

  // 读取 SQL 文件
  const sql = await fs.readFile(migrationFile, 'utf-8');
  
  // 获取数据库连接信息
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mindpal';
  console.log('📡 数据库连接:', dbUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));

  try {
    // 执行迁移
    console.log('\n⚙️  执行 SQL 迁移...');
    const { stdout, stderr } = await execAsync(`psql "${dbUrl}" -f "${migrationFile}"`);
    
    if (stdout) {
      console.log(stdout);
    }
    if (stderr && !stderr.includes('NOTICE')) {
      console.warn('⚠️  警告:', stderr);
    }

    console.log('\n✅ 迁移执行成功！\n');
    console.log('📊 迁移内容:');
    console.log('  - 添加 category 字段 (工具分类)');
    console.log('  - 添加 priority 字段 (优先级 1-10)');
    console.log('  - 添加 tags 字段 (标签数组)');
    console.log('  - 添加 usage_count 字段 (调用次数)');
    console.log('  - 添加 last_used_at 字段 (最后使用时间)');
    console.log('  - 创建复合索引优化查询性能');
    console.log('  - 自动分类现有工具\n');

    console.log('🔍 验证迁移结果:');
    console.log('  运行以下命令查看工具分类统计:');
    console.log('  psql "${dbUrl}" -c "SELECT category, COUNT(*) as count, AVG(priority) as avg_priority FROM tool_definitions GROUP BY category ORDER BY count DESC;"');

  } catch (error: any) {
    console.error('\n❌ 迁移失败:', error.message);
    if (error.stderr) {
      console.error('错误详情:', error.stderr);
    }
    process.exit(1);
  }
}

main().catch(console.error);
