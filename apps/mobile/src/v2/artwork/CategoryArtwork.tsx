import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

export type ServiceId = 'food' | 'shops' | 'pharmacy' | 'local-market' | 'declutter' | 'logistics';

const INK = '#17181B';
const CREAM = '#FFF9EE';

/** Original, code-native illustrations. No board crop or pasted bitmap. */
export function CategoryArtwork({ id, size = 76 }: { id: ServiceId; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96" accessibilityRole="image" accessibilityLabel={`${id} illustration`}>
      {id === 'food' ? <Food /> : null}
      {id === 'shops' ? <Shops /> : null}
      {id === 'pharmacy' ? <Pharmacy /> : null}
      {id === 'local-market' ? <Market /> : null}
      {id === 'declutter' ? <Declutter /> : null}
      {id === 'logistics' ? <Logistics /> : null}
    </Svg>
  );
}

function Food() {
  return <G><Circle cx="48" cy="49" r="29" fill="#F2C47D" /><Circle cx="48" cy="49" r="20" fill={CREAM} stroke={INK} strokeWidth="3" /><Path d="M38 53c3-10 17-15 25-7-2 10-12 17-25 7Z" fill="#D9694F" /><Circle cx="54" cy="44" r="3" fill="#4F8C58" /><Path d="M17 22v52M12 22v17c0 7 10 7 10 0V22M79 22v52M79 22c-9 5-10 22 0 25" stroke={INK} strokeWidth="4" strokeLinecap="round" fill="none" /></G>;
}

function Shops() {
  return <G><Rect x="19" y="34" width="58" height="48" rx="11" fill="#91B2D2" /><Path d="M33 39c0-13 7-22 15-22s15 9 15 22" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" /><Path d="M20 49h56" stroke={INK} strokeWidth="3" /><Rect x="31" y="57" width="13" height="13" rx="3" fill={CREAM} /><Rect x="50" y="57" width="15" height="13" rx="3" fill="#E9B86D" /></G>;
}

function Pharmacy() {
  return <G><Rect x="17" y="29" width="62" height="52" rx="12" fill="#8FC39F" /><Path d="M37 29v-8h22v8" stroke={INK} strokeWidth="4" fill="none" strokeLinejoin="round" /><Path d="M43 42h10v10h10v10H53v10H43V62H33V52h10V42Z" fill={CREAM} /><Rect x="63" y="15" width="17" height="27" rx="6" fill="#E9B86D" stroke={INK} strokeWidth="3" /><Line x1="64" y1="28" x2="79" y2="28" stroke={INK} strokeWidth="3" /></G>;
}

function Market() {
  return <G><Path d="M18 43h60l-7 39H25l-7-39Z" fill="#D88F67" stroke={INK} strokeWidth="3" strokeLinejoin="round" /><Path d="M29 44c2-18 10-28 19-28s17 10 19 28" stroke={INK} strokeWidth="5" fill="none" strokeLinecap="round" /><Circle cx="36" cy="47" r="10" fill="#E8B54F" /><Circle cx="54" cy="43" r="11" fill="#78A96B" /><Circle cx="64" cy="52" r="9" fill="#C84F45" /><Path d="M52 31c-6-8-2-14 7-15-1 8-3 12-7 15Z" fill="#3F7B4A" /></G>;
}

function Declutter() {
  return <G><Path d="M18 38 48 24l30 14-30 15-30-15Z" fill="#C2A2D0" stroke={INK} strokeWidth="3" strokeLinejoin="round" /><Path d="M18 38v34l30 14 30-14V38M48 53v33" fill="none" stroke={INK} strokeWidth="3" strokeLinejoin="round" /><Rect x="30" y="17" width="18" height="26" rx="4" fill="#E9B86D" stroke={INK} strokeWidth="3" transform="rotate(-12 39 30)" /><Circle cx="39" cy="34" r="2" fill={INK} /></G>;
}

function Logistics() {
  return <G><Path d="M16 68h48V36H16v32Z" fill="#93AC8B" stroke={INK} strokeWidth="3" strokeLinejoin="round" /><Path d="M64 48h12l9 10v10H64V48Z" fill="#E9B86D" stroke={INK} strokeWidth="3" strokeLinejoin="round" /><Circle cx="30" cy="70" r="8" fill={CREAM} stroke={INK} strokeWidth="4" /><Circle cx="71" cy="70" r="8" fill={CREAM} stroke={INK} strokeWidth="4" /><Path d="M22 25c9-9 19-9 28 0M54 21l-4 4-4-4" stroke="#A67834" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" /></G>;
}
