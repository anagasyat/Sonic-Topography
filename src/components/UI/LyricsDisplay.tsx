import React, { useMemo, useEffect, useState, useRef } from 'react';
import { parseLRC } from '../../lib/lyrics';

interface LyricsDisplayProps {
  lrcText: string;
  currentTime: number;
  accentHex?: string;
  isPlaying?: boolean;
}

export const LyricsDisplay: React.FC<LyricsDisplayProps> = ({ lrcText, currentTime, accentHex = '#00ffff', isPlaying = true }) => {
  const lyrics = useMemo(() => parseLRC(lrcText), [lrcText]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const [offsetY, setOffsetY] = useState(0);

  useEffect(() => {
    let newIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        if (currentTime >= lyrics[i].time - 0.2) { // 0.2s anticipation
            newIndex = i;
        } else {
            break;
        }
    }
    setActiveIndex(newIndex);
  }, [currentTime, lyrics]);

  useEffect(() => {
     if (scrollWrapperRef.current && containerRef.current) {
         if (activeIndex !== -1) {
             const activeEl = scrollWrapperRef.current.children[activeIndex + 1] as HTMLElement; // +1 for timeline line
             if (activeEl) {
                 const containerCenter = containerRef.current.clientHeight / 2;
                 const elTop = activeEl.offsetTop;
                 const elHeight = activeEl.clientHeight;
                 setOffsetY(containerCenter - elTop - elHeight / 2);
             }
         } else {
             // If before first lyric, show the first lyric a bit lower, or just center the top
             if (scrollWrapperRef.current.children.length > 1) {
                 const firstEl = scrollWrapperRef.current.children[1] as HTMLElement;
                 if (firstEl) {
                     const containerCenter = containerRef.current.clientHeight / 2;
                     const elTop = firstEl.offsetTop;
                     // offset it so the first lyric is a bit below the center
                     setOffsetY(containerCenter - elTop + 60);
                 }
             } else {
                 setOffsetY(0);
             }
         }
     }
  }, [activeIndex, currentTime]);

  if (lyrics.length === 0) return null;

  return (
    <div 
        ref={containerRef}
        className={`absolute left-[80px] top-[40vh] -translate-y-1/2 h-[60vh] w-[800px] overflow-hidden pointer-events-none select-none z-40 transition-all duration-1000 ease-out ${isPlaying ? 'opacity-100 translate-x-0 blur-none' : 'opacity-0 -translate-x-[20px] blur-sm'}`}
        style={{ 
            maskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)',
            perspective: '1200px',
            perspectiveOrigin: 'left center'
        }}
    >
      <div 
        className="px-[40px] flex flex-col relative w-full h-full" 
        style={{
            transform: 'rotateY(20deg) rotateX(5deg) translateZ(-50px)',
            transformOrigin: 'left center',
            transformStyle: 'preserve-3d'
        }}
      >
        <div 
            ref={scrollWrapperRef}
            className="flex flex-col relative w-full"
            style={{ 
                transform: `translateY(${offsetY}px)`,
                transition: 'transform 800ms cubic-bezier(0.2, 0.8, 0.2, 1)'
            }}
        >
            {/* Continuous vertical timeline line */}
            <div className="absolute left-[8px] top-0 bottom-0 w-[1px] bg-white/10 shadow-[0_0_10px_rgba(255,255,255,0.1)]"></div>

            {lyrics.map((line, idx) => {
              const isActive = idx === activeIndex;
              const isPast = idx < activeIndex;
              return (
                <div
                  key={idx}
                  className="relative pl-[40px] py-[14px] w-full transition-all duration-700 ease-out"
                >
                  {/* Timeline Dot */}
                  <div className="absolute left-[8px] top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center">
                     {isActive ? (
                        <div 
                          className="w-4 h-4 rounded-full border-[2px] flex items-center justify-center bg-black/50 transition-all duration-500 ease-out"
                          style={{ borderColor: accentHex, color: accentHex, boxShadow: `0 0 15px ${accentHex}88` }}
                        >
                           <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accentHex }}></div>
                        </div>
                     ) : (
                        <div className="w-[3px] h-[3px] rounded-full bg-white/20 transition-all duration-500 ease-out" style={{ boxShadow: isPast ? `0 0 5px ${accentHex}44` : 'none', backgroundColor: isPast ? accentHex : 'rgba(255,255,255,0.2)' }}></div>
                     )}
                  </div>

                  {/* Lyric Text */}
                  <div
                    className={`transition-all duration-700 ease-out whitespace-pre-wrap font-serif tracking-[0.05em] drop-shadow-xl ${
                        isActive 
                            ? 'text-white text-[32px] font-medium opacity-100' 
                            : isPast
                                ? 'text-white/20 text-[18px] font-normal opacity-40 blur-[1px]' 
                                : 'text-white/40 text-[18px] font-normal opacity-50'
                    }`}
                    style={{
                        transform: isActive ? 'translateY(0) scale(1.05)' : 'translateY(0) scale(1)',
                        transformOrigin: 'left center',
                        textShadow: isActive ? `0 0 20px ${accentHex}66, 0 2px 4px rgba(0,0,0,0.8)` : '0 2px 4px rgba(0,0,0,0.8)'
                    }}
                  >
                    {line.text}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
};
