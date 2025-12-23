# CloudNotes 后端更新指南

## 📋 数据库表结构修改

### SQL 脚本

```sql
-- 删除旧表并创建新表
DROP TABLE IF EXISTS notes;

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  public_id TEXT,
  is_share_copy INTEGER DEFAULT 0,
  
  -- 新增图片支持字段
  has_image INTEGER DEFAULT 0,           -- 是否包含图片 (0/1)
  image_data TEXT,                       -- 加密后的图片 Base64 数据
  image_type VARCHAR(50),                -- 图片 MIME 类型 (image/png, image/jpeg, etc.)
  image_iv TEXT,                         -- 图片加密 IV (JSON 数组格式)
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 如果是已有数据库，使用 ALTER TABLE 添加字段
ALTER TABLE notes ADD COLUMN has_image INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN image_data TEXT;
ALTER TABLE notes ADD COLUMN image_type VARCHAR(50);
ALTER TABLE notes ADD COLUMN image_iv TEXT;
```

---

## 🔧 后端 API 修改方案

### 1. POST `/api/save` - 保存笔记

**修改前端发送的数据结构：**
```javascript
{
  "content": "加密的文本内容",
  "public_id": "可选的公开ID",
  "is_share_copy": 0,
  // 新增字段
  "has_image": 1,                    // 是否包含图片
  "image_data": "base64编码的加密图片数据",
  "image_type": "image/png",         // 图片类型
  "image_iv": "[12,34,56,...]"       // JSON字符串格式的IV数组
}
```

**后端代码示例 (Node.js):**
```javascript
app.post('/api/save', async (req, res) => {
  const { 
    content, 
    public_id, 
    is_share_copy = 0,
    has_image = 0,
    image_data,
    image_type,
    image_iv
  } = req.body;

  // 验证必填字段
  if (!content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // 如果声明有图片，验证图片数据
  if (has_image && (!image_data || !image_type || !image_iv)) {
    return res.status(400).json({ error: 'Image data incomplete' });
  }

  // 插入数据库
  const sql = `
    INSERT INTO notes (content, public_id, is_share_copy, has_image, image_data, image_type, image_iv)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  
  await db.run(sql, [
    content, 
    public_id, 
    is_share_copy,
    has_image,
    image_data,
    image_type,
    image_iv
  ]);

  res.json({ success: true });
});
```

**Cloudflare Worker 示例:**
```javascript
export default {
  async fetch(request, env) {
    if (request.method === 'POST' && url.pathname === '/api/save') {
      const { 
        content, 
        public_id, 
        is_share_copy = 0,
        has_image = 0,
        image_data,
        image_type,
        image_iv
      } = await request.json();

      const sql = `
        INSERT INTO notes (content, public_id, is_share_copy, has_image, image_data, image_type, image_iv)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      await env.DB.prepare(sql)
        .bind(content, public_id, is_share_copy, has_image, image_data, image_type, image_iv)
        .run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
```

---

### 2. GET `/api/list` - 获取笔记列表

**返回数据需包含图片字段：**
```javascript
app.get('/api/list', async (req, res) => {
  const sql = `
    SELECT id, content, public_id, is_share_copy, 
           has_image, image_data, image_type, image_iv, 
           created_at
    FROM notes
    WHERE is_share_copy = 0
    ORDER BY created_at DESC
  `;
  
  const notes = await db.all(sql);
  res.json(notes);
});
```

---

### 3. GET `/api/share/:id` - 阅后即焚获取

**重要：获取后立即删除（包括图片数据）**

```javascript
app.get('/api/share/:id', async (req, res) => {
  const { id } = req.params;

  // 查询分享笔记
  const sql = `
    SELECT id, content, has_image, image_data, image_type, image_iv
    FROM notes
    WHERE public_id = ? AND is_share_copy = 1
  `;
  
  const note = await db.get(sql, [id]);

  if (!note) {
    return res.status(404).json({ error: 'Not found or already burned' });
  }

  // 返回数据
  const response = {
    content: note.content,
    has_image: note.has_image,
    image_data: note.image_data,
    image_type: note.image_type,
    image_iv: note.image_iv
  };

  // 立即删除（阅后即焚）
  await db.run('DELETE FROM notes WHERE id = ?', [note.id]);

  res.json(response);
});
```

**Cloudflare Worker 示例:**
```javascript
// GET /api/share/:id
const publicId = url.pathname.split('/').pop();

const { results } = await env.DB.prepare(
  `SELECT id, content, has_image, image_data, image_type, image_iv 
   FROM notes 
   WHERE public_id = ? AND is_share_copy = 1`
).bind(publicId).all();

if (results.length === 0) {
  return new Response('Not found', { status: 404 });
}

const note = results[0];

// 删除记录（阅后即焚）
await env.DB.prepare('DELETE FROM notes WHERE id = ?')
  .bind(note.id)
  .run();

return new Response(JSON.stringify({
  content: note.content,
  has_image: note.has_image,
  image_data: note.image_data,
  image_type: note.image_type,
  image_iv: note.image_iv
}), {
  headers: { 'Content-Type': 'application/json' }
});
```

---

### 4. POST `/api/delete` - 删除笔记

**无需特殊修改，CASCADE 删除会自动清理图片数据**

```javascript
app.post('/api/delete', async (req, res) => {
  const { id } = req.body;
  
  await db.run('DELETE FROM notes WHERE id = ?', [id]);
  
  res.json({ success: true });
});
```

---

## 🔐 安全建议

1. **图片大小限制**: 在后端也验证图片数据大小
```javascript
if (image_data && image_data.length > 7000000) { // ~5MB Base64
  return res.status(400).json({ error: 'Image too large' });
}
```

2. **MIME 类型验证**:
```javascript
const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
if (image_type && !allowedTypes.includes(image_type)) {
  return res.status(400).json({ error: 'Invalid image type' });
}
```

3. **认证检查**: 确保所有 API 都检查 `Authorization` header

---

## 📝 测试清单

- [ ] 保存仅文本笔记
- [ ] 保存带图片的笔记
- [ ] 加载笔记列表并解密图片
- [ ] 生成阅后即焚分享链接
- [ ] 访问分享链接并解密内容和图片
- [ ] 验证分享链接只能访问一次
- [ ] 删除笔记（包括图片数据）
- [ ] 测试图片大小限制
- [ ] 测试不支持的图片格式

---

## 🚀 部署步骤

1. **备份现有数据库**
2. **执行数据库迁移 SQL**
3. **更新后端代码**
4. **部署新版本**
5. **测试所有功能**

---

## 📞 技术支持

如有问题，请参考：
- 官网: https://www.zzzmxxkj.com
- 项目文档: [CloudNotes Documentation]

---

**最后更新**: 2025-12-23
**版本**: 2.0 (图片加密支持)
**官网**: https://www.zzzmxxkj.com