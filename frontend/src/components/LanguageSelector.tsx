import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon'


const Flags = {
  zh: (
    <svg viewBox="0 0 640 480" preserveAspectRatio="xMidYMid slice" className="w-full h-full">
      <rect x="-100" y="-100" width="1000" height="1000" fill="#ee1c25"/>
      <g transform="translate(40, 30) scale(0.9)">
        <path fill="#ffff00" d="M120 160l-16.5 50.8L147 179.2H93l43.5 31.6zm80-80l-5.1 15.7 13.4-9.7H192l10.7 7.8zm40 40l-5.1 15.7 13.4-9.7H232l10.7 7.8zm0 80l-5.1 15.7 13.4-9.7H232l10.7 7.8zm-40 40l-5.1 15.7 13.4-9.7H192l10.7 7.8z"/>
      </g>
    </svg>
  ),
  en: (
    <svg viewBox="0 0 640 480" preserveAspectRatio="xMidYMid slice" className="w-full h-full scale-110">
      <path fill="#012169" d="M0 0h640v480H0z"/>
      <path fill="#FFF" d="M75 0l245 180L565 0h75v45L413 240l227 195v45h-75L320 300 75 480H0v-45l227-195L0 45V0z"/>
      <path fill="#C8102E" d="M424 281l189 137v22L396 281zm-103 19l243 180h36L321 270zM0 45l213 155-24 18L0 74zm36 0l215 155h38L36 0z"/>
      <path fill="#FFF" d="M256 0v480h128V0zM0 176v128h640V176z"/>
      <path fill="#C8102E" d="M304 0v480h32V0zM0 224v32h640v-32z"/>
    </svg>
  )
};

const languages = [
  { code: 'zh', name: '简体中文' },
  { code: 'en', name: 'English' }
];

export const LanguageSelector: React.FC = () => {
  const { i18n } = useTranslation();
  const currentLang = i18n.language.startsWith('en') ? 'en' : 'zh';
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  useEffect(() => {
    const close = () => setActiveMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const isOpen = activeMenu === 'linear';

  const handleLanguageChange = (code: string) => {
    void i18n.changeLanguage(code);
    setActiveMenu(null);
  };

  return (
    <div 
      className={`group/container relative flex items-center bg-[var(--ui-bg-panel)] border border-[var(--ui-border-default)] rounded-full transition-all duration-700 ease-[cubic-bezier(0.2,1,0.2,1)] shadow-sm hover:shadow-md h-[44px] ${isOpen ? 'w-[160px]' : 'w-[44px]'}`}
      onMouseEnter={() => setActiveMenu('linear')}
      onMouseLeave={() => setActiveMenu(null)}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 触发器按钮 */}
      <div className="absolute left-[4px] top-[4px] w-[34px] h-[34px] pointer-events-none z-10">
         <div className={`w-full h-full rounded-full flex items-center justify-center overflow-hidden transition-all duration-500 border border-slate-50 ${!currentLang ? 'bg-[var(--ui-bg-panel-muted)] text-[var(--ui-text-primary)]' : 'bg-[var(--ui-bg-panel)] shadow-sm'}`}>
          {!currentLang ? (
            <Icon name={"globe"} className={`text-[20px] transition-transform duration-700 ${isOpen ? 'rotate-180 scale-110' : ''}`} />
          ) : (
            <div className="w-full h-full">
              {Flags[currentLang as keyof typeof Flags]}
            </div>
          )}
         </div>
      </div>
      
      <div className={`flex items-center absolute left-[44px] h-full transition-all duration-700 ${isOpen ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8 pointer-events-none'}`}>
        <div className="h-5 w-[1px] bg-[var(--ui-bg-panel-muted)]" />
        
        <div className="flex items-center gap-3 px-4">
          {languages.map(l => (
            <button 
              key={l.code}
              onClick={(e) => {
                e.stopPropagation();
                handleLanguageChange(l.code);
              }}
              className="group/item relative flex flex-col items-center justify-center transition-all"
            >
              {/* 工具提示 */}
              <div className="absolute -top-10 opacity-0 group-hover/item:opacity-100 group-hover/item:-top-12 transition-all duration-300 pointer-events-none">
                <div className="bg-slate-900 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg whitespace-nowrap shadow-xl relative">
                  {l.name}
                  <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-900 rotate-45" />
                </div>
              </div>

              <div className={`w-8 h-8 rounded-full overflow-hidden border-2 transition-all duration-300 ${currentLang === l.code ? 'border-blue-500 scale-110 shadow-lg shadow-blue-100' : 'border-white shadow-sm opacity-50 hover:opacity-100 hover:scale-105'}`}>
                {Flags[l.code as keyof typeof Flags]}
              </div>

              {currentLang === l.code && (
                <div className="absolute -bottom-2 w-1 h-1 bg-blue-500 rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};


