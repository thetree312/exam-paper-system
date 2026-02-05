<p align="center">
  <a href="README.md">
    <img src="https://img.shields.io/badge/US-English-0066CC?style=for-the-badge" alt="English">
  </a>
  <a href="README.zh-CN.md">
    <img src="https://img.shields.io/badge/CN-简体中文-FF6B35?style=for-the-badge" alt="简体中文">
  </a>
</p>

# 📚 Exam Paper Management System

A comprehensive exam paper management system with OCR capabilities and AI-powered features, built for educational institutions and students.

## ✨ Features

### 🎯 Core Functionality
- **📄 PDF Processing**: Upload and process exam papers in PDF format
- **🔍 OCR Recognition**: Advanced text extraction using GLM OCR and PaddleOCR
- **🤖 AI Assistant**: Intelligent agent for question answering and assistance
- **📊 Question Management**: Organize and categorize exam questions by type and subject
- **🎨 Visual Editor**: Rich text editor for question editing and formatting

### 🛠️ Technical Features
- **🌐 Modern Web Interface**: React + TypeScript frontend with responsive design
- **⚡ High-Performance Backend**: FastAPI with PostgreSQL database
- **🔄 Real-time Updates**: WebSocket support for live collaboration
- **📱 Mobile Friendly**: Fully responsive design for all devices
- **🔐 Secure Authentication**: User management and access control

## 🚀 Quick Start

### Prerequisites
- Python 3.11+
- Node.js 18+
- PostgreSQL 14+
- Redis (optional, for caching)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/thetree312/exam-paper-system.git
   cd exam-paper-system
   ```

2. **Backend Setup**
   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   
   # Setup database
   python scripts/setup_postgres_db.py
   
   # Start the server
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

3. **Frontend Setup**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

4. **Access the Application**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000
   - API Documentation: http://localhost:8000/docs

## 📁 Project Structure

```
exam-paper-system/
├── backend/                 # FastAPI backend
│   ├── app/                # Application modules
│   │   ├── routers/         # API endpoints
│   │   ├── models/          # Database models
│   │   ├── services/        # Business logic
│   │   └── utils/          # Utilities
│   ├── scripts/            # Database and utility scripts
│   └── requirements.txt     # Python dependencies
├── frontend/               # React frontend
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── hooks/          # Custom hooks
│   │   ├── services/        # API services
│   │   └── utils/          # Frontend utilities
│   └── package.json        # Node.js dependencies
└── README.md              # This file
```

## 🔧 Configuration

### Environment Variables

**Backend (.env)**
```env
DATABASE_URL=postgresql+psycopg2://user:password@localhost:5432/exam_paper_dev
REDIS_URL=redis://localhost:6379
SECRET_KEY=your-secret-key-here
```

**Frontend (.env)**
```env
VITE_API_URL=http://localhost:8000
VITE_WS_URL=ws://localhost:8000/ws
```

## 🤖 AI Features

### OCR Capabilities
- **GLM OCR**: Advanced text recognition for complex layouts
- **PaddleOCR**: High-accuracy Chinese and English text extraction
- **Layout Analysis**: Automatic detection of questions, answers, and metadata
- **Multi-language Support**: Process exams in various languages

### Intelligent Assistant
- **Question Answering**: AI-powered responses to student questions
- **Content Generation**: Create practice questions and explanations
- **Topic Analysis**: Identify key concepts and difficulty levels
- **Study Recommendations**: Personalized learning suggestions

## 📊 Database Schema

The system uses PostgreSQL with the following main tables:
- `users` - User management and authentication
- `documents` - Exam paper storage and metadata
- `questions` - Individual question data
- `subjects` - Subject categorization
- `tags` - Question tagging system
- `agent_sessions` - AI conversation history

## 🔒 Security Features

- **JWT Authentication**: Secure token-based authentication
- **Input Validation**: Comprehensive input sanitization
- **Rate Limiting**: API endpoint protection
- **CORS Configuration**: Cross-origin request security
- **SQL Injection Prevention**: Parameterized queries throughout

## 🧪 Testing

```bash
# Backend tests
cd backend
pytest

# Frontend tests
cd frontend
npm test
```

## 📈 Performance

- **Optimized Queries**: Database indexing and query optimization
- **Caching Strategy**: Redis-based caching for frequent requests
- **Lazy Loading**: Frontend code splitting and lazy loading
- **Image Optimization**: Efficient image processing and storage

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 API Documentation

Once the backend is running, visit `http://localhost:8000/docs` for interactive API documentation.

### Key Endpoints
- `POST /api/documents/upload` - Upload exam papers
- `GET /api/questions/{document_id}` - Extract questions from documents
- `POST /api/agent/chat` - Interact with AI assistant
- `GET /api/subjects` - Get available subjects

## 🐛 Troubleshooting

### Common Issues

1. **OCR Model Loading**
   - Ensure sufficient disk space for model downloads
   - Check internet connection for initial model setup
   - Verify model file permissions

2. **Database Connection**
   - Confirm PostgreSQL is running
   - Check connection string in environment variables
   - Ensure database exists and is properly migrated

3. **Frontend Build Issues**
   - Clear node_modules and reinstall: `rm -rf node_modules && npm install`
   - Check Node.js version compatibility
   - Verify environment variables

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [GLM OCR](https://github.com/THUDM/GLM) for advanced OCR capabilities
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) for high-accuracy text recognition
- [FastAPI](https://fastapi.tiangolo.com/) for the backend framework
- [React](https://reactjs.org/) for the frontend framework

## 📞 Support

For support and questions:
- Create an issue on GitHub
- Check the [API Documentation](http://localhost:8000/docs)
- Review the troubleshooting section above

---

<div align="center">
  <p>Made with ❤️ for educational excellence</p>
  <p>
    <a href="#top">Back to top</a>
  </p>
</div>
