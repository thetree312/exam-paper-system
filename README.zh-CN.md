<p align="center">
  <a href="README.md">
    <img src="https://img.shields.io/badge/English-GB-lightgrey?style=for-the-badge" alt="English">
  </a>
  <a href="README.zh-CN.md">
    <img src="https://img.shields.io/badge/简体中文-CN-red?style=for-the-badge" alt="简体中文">
  </a>
</p>

# 📚 试卷管理系统

一个全面的试卷管理系统，具备 OCR 功能和 AI 驱动的特性，为教育机构和学生构建。

## ✨ 功能特性

### 🎯 核心功能
- **📄 PDF 处理**：上传和处理 PDF 格式的试卷
- **🔍 OCR 识别**：使用 GLM OCR 和 PaddleOCR 进行高级文本提取
- **🤖 AI 助手**：智能代理用于问答和辅助
- **📊 题目管理**：按类型和学科组织和分类考试题目
- **🎨 可视化编辑器**：用于题目编辑和格式化的富文本编辑器

### 🛠️ 技术特性
- **🌐 现代网页界面**：React + TypeScript 前端，响应式设计
- **⚡ 高性能后端**：FastAPI 配合 PostgreSQL 数据库
- **🔄 实时更新**：WebSocket 支持实时协作
- **📱 移动友好**：完全响应式设计适配所有设备
- **🔐 安全认证**：用户管理和访问控制

## 🚀 快速开始

### 前置要求
- Python 3.11+
- Node.js 18+
- PostgreSQL 14+
- Redis（可选，用于缓存）

### 安装

1. **克隆仓库**
   ```bash
   git clone https://github.com/thetree312/exam-paper-system.git
   cd exam-paper-system
   ```

2. **后端设置**
   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   
   # 设置数据库
   python scripts/setup_postgres_db.py
   
   # 启动服务器
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

3. **前端设置**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

4. **访问应用**
   - 前端：http://localhost:5173
   - 后端 API：http://localhost:8000
   - API 文档：http://localhost:8000/docs

## 📁 项目结构

```
exam-paper-system/
├── backend/                 # FastAPI 后端
│   ├── app/                # 应用模块
│   │   ├── routers/         # API 端点
│   │   ├── models/          # 数据库模型
│   │   ├── services/        # 业务逻辑
│   │   └── utils/          # 工具函数
│   ├── scripts/            # 数据库和工具脚本
│   └── requirements.txt     # Python 依赖
├── frontend/               # React 前端
│   ├── src/
│   │   ├── components/      # React 组件
│   │   ├── hooks/          # 自定义钩子
│   │   ├── services/        # API 服务
│   │   └── utils/          # 前端工具
│   └── package.json        # Node.js 依赖
└── README.md              # 本文件
```

## 🔧 配置

### 环境变量

**后端 (.env)**
```env
DATABASE_URL=postgresql+psycopg2://user:password@localhost:5432/exam_paper_dev
REDIS_URL=redis://localhost:6379
SECRET_KEY=your-secret-key-here
```

**前端 (.env)**
```env
VITE_API_URL=http://localhost:8000
VITE_WS_URL=ws://localhost:8000/ws
```

## 🤖 AI 功能

### OCR 能力
- **GLM OCR**：复杂布局的高级文本识别
- **PaddleOCR**：中英文高精度文本提取
- **布局分析**：自动检测题目、答案和元数据
- **多语言支持**：处理各种语言的试卷

### 智能助手
- **问答功能**：AI 驱动的学生问题回答
- **内容生成**：创建练习题和解释
- **主题分析**：识别关键概念和难度级别
- **学习建议**：个性化学习推荐

## 📊 数据库架构

系统使用 PostgreSQL，包含以下主要表：
- `users` - 用户管理和认证
- `documents` - 试卷存储和元数据
- `questions` - 单个题目数据
- `subjects` - 学科分类
- `tags` - 题目标签系统
- `agent_sessions` - AI 对话历史

## 🔒 安全特性

- **JWT 认证**：安全的令牌式认证
- **输入验证**：全面的输入清理
- **速率限制**：API 端点保护
- **CORS 配置**：跨域请求安全
- **SQL 注入防护**：全程参数化查询

## 🧪 测试

```bash
# 后端测试
cd backend
pytest

# 前端测试
cd frontend
npm test
```

## 📈 性能

- **查询优化**：数据库索引和查询优化
- **缓存策略**：基于 Redis 的频繁请求缓存
- **懒加载**：前端代码分割和懒加载
- **图像优化**：高效的图像处理和存储

## 🤝 贡献

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开 Pull Request

## 📝 API 文档

后端运行后，访问 `http://localhost:8000/docs` 获取交互式 API 文档。

### 主要端点
- `POST /api/documents/upload` - 上传试卷
- `GET /api/questions/{document_id}` - 从文档提取题目
- `POST /api/agent/chat` - 与 AI 助手交互
- `GET /api/subjects` - 获取可用学科

## 🐛 故障排除

### 常见问题

1. **OCR 模型加载**
   - 确保有足够的磁盘空间下载模型
   - 检查初始模型设置的网络连接
   - 验证模型文件权限

2. **数据库连接**
   - 确认 PostgreSQL 正在运行
   - 检查环境变量中的连接字符串
   - 确保数据库存在并正确迁移

3. **前端构建问题**
   - 清除 node_modules 并重新安装：`rm -rf node_modules && npm install`
   - 检查 Node.js 版本兼容性
   - 验证环境变量

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- [GLM OCR](https://github.com/THUDM/GLM) 提供高级 OCR 功能
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 提供高精度文本识别
- [FastAPI](https://fastapi.tiangolo.com/) 提供后端框架
- [React](https://reactjs.org/) 提供前端框架

## 📞 支持

如需支持和提问：
- 在 GitHub 上创建 issue
- 查看 [API 文档](http://localhost:8000/docs)
- 阅读上述故障排除部分

---

<div align="center">
  <p>用 ❤️ 为教育卓越而打造</p>
  <p>
    <a href="#top">返回顶部</a>
  </p>
</div>
