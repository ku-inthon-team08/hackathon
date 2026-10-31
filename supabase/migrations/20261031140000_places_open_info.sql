-- 쉼터 운영시간: places에 주소·운영시간을 담고, 지금 열려 있는지 판단하는 함수를 둔다.
-- open_info 예: {"weekday": "09:00~22:00", "weekend": "09:00~20:00", "closed": "매주 화요일 및 법정공휴일"}
-- 공원처럼 운영시간이 없으면(null) 늘 열려 있다고 본다. 법정공휴일은 판단하지 않는다.

alter table public.places add column if not exists address text;
alter table public.places add column if not exists open_info jsonb;

create or replace function public.place_is_open(open_info jsonb, at timestamptz default now())
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  kst timestamp := at at time zone 'Asia/Seoul';
  dow int := extract(isodow from kst);                         -- 1 월 ~ 7 일
  day_name text := (array['월', '화', '수', '목', '금', '토', '일'])[dow] || '요일';
  week_of_month int := (extract(day from kst)::int - 1) / 7 + 1;
  closed text := coalesce(open_info ->> 'closed', '');
  hours text;
  m text[];
begin
  if open_info is null then
    return true;
  end if;

  -- 정기 휴관일: "매주 화요일", "2,4주 월요일" 같은 꼴
  if position(day_name in closed) > 0 then
    m := regexp_match(closed, '([0-9,]+)주\s*' || day_name);
    if m is null or week_of_month::text = any (string_to_array(m[1], ',')) then
      return false;
    end if;
  end if;

  -- 운영시간: 주말 칸에 "토요일:10:00~16:00"처럼 토요일만 적혀 있으면 일요일은 닫힌 것으로 본다
  hours := case when dow >= 6 then open_info ->> 'weekend' else open_info ->> 'weekday' end;
  if dow = 7 and hours like '%토요일%' and hours not like '%일요일%' then
    return false;
  end if;
  m := regexp_match(coalesce(hours, ''), '(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})');
  if m is null then
    return true;  -- 시간을 읽지 못하면 막지 않는다
  end if;
  return kst::time >= m[1]::time and kst::time < m[2]::time;
end;
$$;
