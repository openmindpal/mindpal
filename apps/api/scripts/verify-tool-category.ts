#!/usr/bin/env node
/**
 * 验证脚本：检查工具分类和优先级数据
 * 
 * 使用方法:
 *   npm run verify:tool-category
 */

import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';

async function main() {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);

  try {
    console.log('🔍 开始验证工具分类数据...\n');

    // 1. 查询分类统计
    console.log('📊 工具分类统计:');
    const categoryRes = await pool.query(`
      SELECT 
        category,
        COUNT(*) as count,
        ROUND(AVG(priority), 1) as avg_priority,
        MIN(priority) as min_priority,
        MAX(priority) as max_priority
      FROM tool_definitions
      GROUP BY category
      ORDER BY count DESC
    `);

    console.table(categoryRes.rows);

    // 2. 查询高优先级工具 (priority >= 9)
    console.log('\n⭐ 高优先级工具 (priority >= 9):');
    const highPriorityRes = await pool.query(`
      SELECT name, display_name, category, priority, tags
      FROM tool_definitions
      WHERE priority >= 9
      ORDER BY priority DESC, name ASC
      LIMIT 20
    `);

    console.table(highPriorityRes.rows.map(r => ({
      name: r.name,
      displayName: r.display_name ? (typeof r.display_name === 'string' ? JSON.parse(r.display_name)['zh-CN'] : r.display_name['zh-CN']) : '-',
      category: r.category,
      priority: r.priority,
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 3).join(', ') : '-'
    })));

    // 3. 查询 AI 类工具
    console.log('\n🤖 AI 类工具:');
    const aiRes = await pool.query(`
      SELECT name, display_name, priority, tags
      FROM tool_definitions
      WHERE category = 'ai'
      ORDER BY priority DESC
      LIMIT 15
    `);

    console.table(aiRes.rows.map(r => ({
      name: r.name,
      displayName: r.display_name ? (typeof r.display_name === 'string' ? JSON.parse(r.display_name)['zh-CN'] : r.display_name['zh-CN']) : '-',
      priority: r.priority,
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 3).join(', ') : '-'
    })));

    // 4. 查询有 displayName 的工具比例
    console.log('\n📈 元数据完整度:');
    const completenessRes = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(display_name) as has_display_name,
        COUNT(description) as has_description,
        COUNT(CASE WHEN category != 'uncategorized' THEN 1 END) as has_category,
        ROUND(COUNT(display_name) * 100.0 / COUNT(*), 1) as display_name_pct,
        ROUND(COUNT(description) * 100.0 / COUNT(*), 1) as description_pct,
        ROUND(COUNT(CASE WHEN category != 'uncategorized' THEN 1 END) * 100.0 / COUNT(*), 1) as category_pct
      FROM tool_definitions
    `);

    console.table(completenessRes.rows);

    // 5. 查询标签使用统计
    console.log('\n🏷️  热门标签 Top 10:');
    const tagsRes = await pool.query(`
      SELECT tag, COUNT(*) as count
      FROM tool_definitions, UNNEST(tags) as tag
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 10
    `);

    console.table(tagsRes.rows);

    console.log('\n✅ 验证完成！\n');

  } catch (error) {
    console.error('❌ 验证失败:', error);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
