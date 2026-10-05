import { Bar, Panel } from "@/components/kit";

/* Shape-matched skeleton. It mirrors the overview's real layout so the
   transition into content does not move anything. */
export default function Loading() {
  return (
    <div className="space-y-7" aria-busy>
      <header>
        <Bar w="35%" h={9} />
        <Bar w="60%" h={26} className="mt-3" />
        <Bar w="80%" h={11} className="mt-3" />
      </header>

      <Panel className="rounded-[16px] p-[1px]">
        <div className="rounded-[15px] bg-surface p-5">
          <Bar w="40%" h={9} />
          <Bar w="70%" h={20} className="mt-4" />
          <Bar w="40%" h={20} className="mt-2" />
          <div className="mt-6 flex items-center justify-between border-t border-edge pt-4">
            <Bar w="45%" h={22} />
            <Bar w="30%" h={30} />
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Panel key={i} className="rounded-[14px] p-4">
            <Bar w="45%" h={9} />
            <Bar w="70%" h={24} className="mt-3" />
            <Bar w="85%" h={10} className="mt-3" />
          </Panel>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Bar w="18%" h={15} />
          <Bar w="40%" h={30} />
        </div>
        <Panel className="rounded-[14px] p-3">
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Bar w={38} h={11} className="shrink-0" />
                <Bar w="40%" h={14} />
                <div className="ml-auto hidden sm:block">
                  <Bar w={96} h={20} />
                </div>
                <Bar w="25%" h={11} />
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
