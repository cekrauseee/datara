import { Skeleton } from '@/components/ui/skeleton'

export function MapSkeleton({ outline }: { outline: string }) {
  return (
    <div className="pointer-events-none absolute inset-0" role="status">
      <span className="sr-only">Carregando o mapa…</span>
      <Skeleton
        aria-hidden="true"
        className="absolute inset-x-[7%] inset-y-[10%] rounded-none motion-reduce:animate-none"
        style={{
          maskImage: `url(${import.meta.env.BASE_URL}${outline})`,
          maskSize: 'contain',
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
        }}
      />
    </div>
  )
}
