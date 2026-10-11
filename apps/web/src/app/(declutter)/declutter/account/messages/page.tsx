'use client';
import { HubInbox } from '@/components/declutter/HubChat';
import { HubAuth } from '@/components/declutter/SellerHub';
import { useSessionState } from '@/lib/session';
export default function Page() { const session=useSessionState(); return <main id="main" className="mx-auto max-w-[1240px] px-5 py-10 sm:px-8">{session==='authenticated'?<HubInbox/>:<HubAuth session={session} returnTo="/declutter/account/messages"/>}</main>; }
