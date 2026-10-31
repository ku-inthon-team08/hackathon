"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { PlaceSheet, type SheetTarget } from "@/components/PlaceSheet";
import { ShelterSearch } from "@/components/ShelterList";
import { Mascot, TopBar } from "@/components/ui";
import { useSensitivity } from "@/lib/storage";

export default function RefugesPage() {
  const router = useRouter();
  const { ready, sens } = useSensitivity();
  const [target, setTarget] = useState<SheetTarget | null>(null);

  // Next keeps visited pages alive, so close the sheet when this page hides.
  useLayoutEffect(() => () => setTarget(null), []);

  return (
    <main className="page">
      <TopBar title="가까운 쉼터">
        <Mascot pose="sit" height={44} />
      </TopBar>

      {ready && <ShelterSearch sens={sens} onPick={setTarget} />}

      {target && (
        <PlaceSheet
          target={target}
          onClose={() => setTarget(null)}
          onGo={(to) => {
            const query = new URLSearchParams({
              toName: to.name,
              toLat: String(to.lat),
              toLng: String(to.lng),
            });
            router.push(`/?${query}`);
          }}
        />
      )}
    </main>
  );
}
