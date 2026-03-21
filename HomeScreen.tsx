import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type EventType = 'class' | 'event' | 'assignment';
type RepeatRule = 'none' | 'MWF' | 'TuTh' | 'MW' | 'daily' | 'weekly';

export type UscEvent = {
  id: string;
  title: string;
  type: EventType;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  location: string;
  completed: boolean;
  repeat: RepeatRule;
  repeatUntil: string; // YYYY-MM-DD
};

type ViewMode = 'week' | 'month';
type DayDetailMode = 'list' | 'timeline';

const STORAGE_KEY = '@usccompanion:events:v1';
const OLD_STORAGE_KEY = '@usccompanion:scheduleItems';
const ASSIGNMENTS_STORAGE_KEY = '@usccompanion:assignments:v1';

const USC_CARDINAL = '#990000';
const USC_GOLD = '#FFCC00';

function pad2(n: number): string {
  return `${n}`.padStart(2, '0');
}

function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateKey(dateKey: string): Date | null {
  if (!isValidDateKey(dateKey)) return null;
  const [y, m, d] = dateKey.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  // Ensure Date didn't overflow (e.g. 2026-02-31)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getStartOfWeek(date: Date): Date {
  // Monday-first week
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 (Sun) - 6 (Sat)
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

function startOfMonth(cursor: Date): Date {
  const d = new Date(cursor);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d;
}

function endOfMonth(cursor: Date): Date {
  const d = startOfMonth(cursor);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getColorForEventType(type: EventType): string {
  if (type === 'class') return '#007AFF'; // blue
  if (type === 'event') return '#34C759'; // green
  return USC_CARDINAL; // assignment (USC red)
}

function getEventTypeLabel(type: EventType): string {
  if (type === 'class') return 'Class';
  if (type === 'event') return 'Event';
  return 'Assignment';
}

function expandSingleRecurring(event: UscEvent): UscEvent[] {
  const start = parseDateKey(event.date);
  const until = parseDateKey(event.repeatUntil);
  if (!start || !until) {
    return [{ ...event, repeat: 'none', repeatUntil: event.date }];
  }

  if (until.getTime() < start.getTime() || event.repeat === 'none') {
    return [{ ...event, repeat: 'none' }];
  }

  const occurrences: Date[] = [];

  const weekdayMatches = (dow: number): boolean => {
    // JS getDay: 0 Sun ... 6 Sat
    if (event.repeat === 'daily') return true;
    if (event.repeat === 'MWF') return dow === 1 || dow === 3 || dow === 5;
    if (event.repeat === 'TuTh') return dow === 2 || dow === 4;
    if (event.repeat === 'MW') return dow === 1 || dow === 3;
    return false;
  };

  if (event.repeat === 'weekly') {
    // Same weekday every 7 days starting from the provided date.
    for (let d = new Date(start); d.getTime() <= until.getTime(); d = addDays(d, 7)) {
      occurrences.push(new Date(d));
    }
  } else {
    for (let d = new Date(start); d.getTime() <= until.getTime(); d = addDays(d, 1)) {
      if (weekdayMatches(d.getDay())) occurrences.push(new Date(d));
    }
  }

  if (occurrences.length === 0) {
    // If a rule yields no matches in-range, keep the chosen start date.
    occurrences.push(start);
  }

  return occurrences.map((occDate) => {
    const occKey = toDateKey(occDate);
    return {
      ...event,
      id: `${event.id}__${occKey}`,
      date: occKey,
      repeat: 'none',
      repeatUntil: event.repeatUntil,
    };
  });
}

function expandRecurringEvents(events: UscEvent[]): UscEvent[] {
  const expanded: UscEvent[] = [];
  for (const ev of events) {
    if (ev.repeat && ev.repeat !== 'none') {
      expanded.push(...expandSingleRecurring(ev));
    } else {
      expanded.push({ ...ev, repeat: 'none' });
    }
  }
  return expanded;
}

function ThinProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <View style={styles.thinBarBg}>
      <View style={[styles.thinBarFill, { width: `${clamped}%` }]} />
    </View>
  );
}

function parseTimeToMinutes(time: string): number | null {
  // HH:MM (24h)
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function minutesToTime(mins: number): string {
  const clamped = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function SwipeToDeleteRow({
  onDelete,
  children,
}: {
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const rowWidthRef = useRef(0);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) => {
          const isHorizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy);
          return isHorizontal && Math.abs(gesture.dx) > 8;
        },
        onPanResponderMove: (_evt, gesture) => {
          const nextX = Math.min(0, gesture.dx); // only swipe left
          translateX.setValue(nextX);
        },
        onPanResponderRelease: (_evt, gesture) => {
          const width = rowWidthRef.current || 1;
          const shouldDelete = gesture.dx < -width / 2;
          if (shouldDelete) {
            Animated.timing(translateX, {
              toValue: -width,
              duration: 140,
              useNativeDriver: true,
            }).start(() => onDelete());
            return;
          }
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            tension: 120,
            friction: 16,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            tension: 120,
            friction: 16,
          }).start();
        },
      }),
    [onDelete, translateX],
  );

  return (
    <View
      style={styles.swipeRowOuter}
      onLayout={(e) => {
        rowWidthRef.current = e.nativeEvent.layout.width;
      }}
    >
      <View style={styles.deleteUnderlay}>
        <Text style={styles.deleteUnderlayIcon}>🗑️</Text>
        <Text style={styles.deleteUnderlayText}>Delete</Text>
      </View>
      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function formatWeekTitle(weekStart: Date): string {
  const startKey = toDateKey(weekStart);
  const endKey = toDateKey(addDays(weekStart, 6));
  const s = parseDateKey(startKey);
  const e = parseDateKey(endKey);
  if (!s || !e) return 'Week';
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthShort[s.getMonth()]} ${s.getDate()} – ${monthShort[e.getMonth()]} ${e.getDate()}`;
}

function formatMonthTitle(cursor: Date): string {
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthShort[cursor.getMonth()]} ${cursor.getFullYear()}`;
}

function getMonthGrid(cursor: Date): { dateKey: string; date: Date; inMonth: boolean }[] {
  const first = startOfMonth(cursor);
  const last = endOfMonth(cursor);
  const gridStart = getStartOfWeek(first);
  const gridEnd = addDays(getStartOfWeek(last), 6);

  const days: { dateKey: string; date: Date; inMonth: boolean }[] = [];
  for (let d = new Date(gridStart); d.getTime() <= gridEnd.getTime(); d = addDays(d, 1)) {
    const dk = toDateKey(d);
    days.push({ dateKey: dk, date: d, inMonth: d.getMonth() === cursor.getMonth() });
  }
  return days;
}

export const HomeScreen: React.FC<{ onOpenAssignments?: () => void }> = ({ onOpenAssignments }) => {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const todayKey = useMemo(() => toDateKey(today), [today]);

  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [dayDetailMode, setDayDetailMode] = useState<DayDetailMode>('list');
  const [weekStart, setWeekStart] = useState<Date>(() => getStartOfWeek(today));
  const [monthCursor, setMonthCursor] = useState<Date>(() => startOfMonth(today));
  const [selectedDateKey, setSelectedDateKey] = useState<string>(() => todayKey);

  const [events, setEvents] = useState<UscEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const hydratedRef = useRef(false);
  const timelineScrollRef = useRef<ScrollView | null>(null);

  // Add modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState<EventType>('class');
  const [newDate, setNewDate] = useState<string>(todayKey);
  const [newStartTime, setNewStartTime] = useState<string>('10:00');
  const [newEndTime, setNewEndTime] = useState<string>('11:00');
  const [newLocation, setNewLocation] = useState<string>('');
  const [newRepeat, setNewRepeat] = useState<RepeatRule>('none');
  const [newRepeatUntil, setNewRepeatUntil] = useState<string>(todayKey);

  useEffect(() => {
    const load = async () => {
      try {
        const [rawNew, rawOld, rawAssignments] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          AsyncStorage.getItem(OLD_STORAGE_KEY),
          AsyncStorage.getItem(ASSIGNMENTS_STORAGE_KEY),
        ]);
        console.log('RAW ASSIGNMENTS:', rawAssignments);
  
        let parsed: UscEvent[] | null = null;
  
        if (rawNew) {
          const maybe = JSON.parse(rawNew) as any[];
          parsed = (Array.isArray(maybe) ? maybe : []).map((it) => {
            const startTime: string =
              typeof it.startTime === 'string'
                ? it.startTime
                : typeof it.time === 'string'
                  ? it.time
                  : '';
            const endTime: string =
              typeof it.endTime === 'string'
                ? it.endTime
                : typeof it.time === 'string'
                  ? minutesToTime((parseTimeToMinutes(it.time) ?? 0) + 60)
                  : '';
            return {
              id: String(it.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
              title: String(it.title ?? ''),
              type: (it.type as EventType) ?? 'event',
              date: String(it.date ?? todayKey),
              startTime,
              endTime,
              location: String(it.location ?? ''),
              completed: Boolean(it.completed ?? false),
              repeat: (it.repeat as RepeatRule) ?? 'none',
              repeatUntil: String(it.repeatUntil ?? it.date ?? todayKey),
            } satisfies UscEvent;
          });
        } else if (rawOld) {
          const legacyItems = JSON.parse(rawOld) as Array<{
            id: string;
            title: string;
            type: 'Class' | 'Event' | 'Assignment';
            date: string;
            time: string;
            location: string;
          }>;
          parsed = legacyItems.map((it) => {
            const mappedType: EventType =
              it.type === 'Class' ? 'class' : it.type === 'Event' ? 'event' : 'assignment';
            return {
              id: it.id,
              title: it.title,
              type: mappedType,
              date: it.date,
              startTime: it.time,
              endTime: minutesToTime((parseTimeToMinutes(it.time) ?? 0) + 60),
              location: it.location ?? '',
              completed: false,
              repeat: 'none',
              repeatUntil: it.date,
            };
          });
        }
  
        // Merge assignments from AssignmentTracker into calendar
        if (rawAssignments) {
          const assignmentList = JSON.parse(rawAssignments) as Array<{
            id: string;
            title: string;
            course: string;
            dueDate: string;
            priority: string;
            completed: boolean;
          }>;
          if (Array.isArray(assignmentList)) {
            const assignmentEvents: UscEvent[] = assignmentList.map((a) => ({
              id: `tracker__${a.id}`,
              title: `${a.title} (${a.course})`,
              type: 'assignment' as EventType,
              date: a.dueDate,
              startTime: '23:59',
              endTime: '23:59',
              location: '',
              completed: a.completed,
              repeat: 'none',
              repeatUntil: a.dueDate,
            }));
            parsed = [...(parsed ?? []), ...assignmentEvents];
          }
        }
  
        const expanded = parsed ? expandRecurringEvents(parsed) : [];
        setEvents(expanded);
      } catch (e) {
        console.warn('Failed to load events', e);
        setEvents([]);
      } finally {
        setLoading(false);
        hydratedRef.current = true;
      }
    };
  
    load();
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const save = async () => {
      try {
        // Only save non-tracker events to avoid polluting main storage
        const eventsToSave = events.filter(e => !e.id.startsWith('tracker__'));
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(eventsToSave));
      } catch (e) {
        console.warn('Failed to save events', e);
      }
    };
    save();
  }, [events]);

  const weekDays = useMemo(() => {
    const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    const days: { label: string; dateKey: string; dayNumber: number; date: Date }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      days.push({
        label: labels[i],
        dateKey: toDateKey(d),
        dayNumber: d.getDate(),
        date: d,
      });
    }
    return days;
  }, [weekStart]);

  const selectedDateEvents = useMemo(() => {
    return events
      .filter((e) => e.date === selectedDateKey)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }, [events, selectedDateKey]);

  const assignmentsByDay = useMemo(() => {
    const map = new Map<string, { total: number; completed: number }>();
    for (const e of events) {
      if (e.type !== 'assignment') continue;
      const cur = map.get(e.date) ?? { total: 0, completed: 0 };
      cur.total += 1;
      if (e.completed) cur.completed += 1;
      map.set(e.date, cur);
    }
    return map;
  }, [events]);

  const getAssignmentProgressForDay = (dateKey: string): number => {
    const stats = assignmentsByDay.get(dateKey);
    if (!stats || stats.total === 0) return 0;
    return Math.round((stats.completed / stats.total) * 100);
  };

  const selectedWeekDayIndex = useMemo(() => {
    const selectedDt = parseDateKey(selectedDateKey);
    if (!selectedDt) return 0;
    const diffMs = selectedDt.getTime() - weekStart.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    return Math.max(0, Math.min(6, diffDays));
  }, [selectedDateKey, weekStart]);

  const handlePrevNext = (delta: number) => {
    if (viewMode === 'week') {
      const newWeekStart = addDays(weekStart, delta * 7);
      setWeekStart(newWeekStart);
      const newSelected = toDateKey(addDays(newWeekStart, selectedWeekDayIndex));
      setSelectedDateKey(newSelected);
    } else {
      const d = new Date(monthCursor);
      d.setMonth(d.getMonth() + delta);
      setMonthCursor(startOfMonth(d));
    }
  };

  const handleSelectDayFromMonth = (dateKey: string) => {
    const dt = parseDateKey(dateKey);
    if (!dt) return;
    setSelectedDateKey(dateKey);
    setWeekStart(getStartOfWeek(dt));
    setDayDetailMode('list');
    setViewMode('week');
  };

  const itemsForSelectedDayEmpty = selectedDateEvents.length === 0;

  const toggleAssignmentCompleted = (id: string) => {
    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        if (e.type !== 'assignment') return e;
        return { ...e, completed: !e.completed };
      }),
    );
  };

  const openAddModal = () => {
    setNewTitle('');
    setNewType('class');
    setNewDate(selectedDateKey);
    setNewStartTime('10:00');
    setNewEndTime('11:00');
    setNewLocation('');
    setNewRepeat('none');
    setNewRepeatUntil(selectedDateKey);
    setModalVisible(true);
  };

  const deleteEventById = (id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
  };

  const addEvents = (payload: {
    title: string;
    type: EventType;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    repeat: RepeatRule;
    repeatUntil: string;
  }) => {
    const baseId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const baseEvent: UscEvent = {
      id: baseId,
      title: payload.title.trim(),
      type: payload.type,
      date: payload.date,
      startTime: payload.startTime,
      endTime: payload.endTime,
      location: payload.location.trim(),
      completed: false,
      repeat: payload.repeat,
      repeatUntil: payload.repeatUntil,
    };

    const instances: UscEvent[] =
      payload.repeat === 'none'
        ? [
            {
              ...baseEvent,
              repeat: 'none',
              repeatUntil: payload.date,
            },
          ]
        : expandSingleRecurring(baseEvent);
    setEvents((prev) => [...prev, ...instances]);
    setModalVisible(false);
  };

  const monthGrid = useMemo(() => getMonthGrid(monthCursor), [monthCursor]);

  const renderEventCard = ({ item }: { item: UscEvent }) => {
    const color = getColorForEventType(item.type);
    const showCheckbox = item.type === 'assignment';
    return (
      <SwipeToDeleteRow onDelete={() => deleteEventById(item.id)}>
        <View style={styles.card}>
          <View style={[styles.cardLeftBorder, { backgroundColor: color }]} />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.cardMeta}>
              {item.startTime && item.endTime
                ? `${item.startTime} – ${item.endTime}`
                : item.startTime
                  ? item.startTime
                  : 'Time TBA'}{' '}
              • {item.location ? item.location : 'Location TBA'}
            </Text>
            {showCheckbox ? (
              <TouchableOpacity
                style={styles.assignmentRow}
                onPress={() => toggleAssignmentCompleted(item.id)}
                activeOpacity={0.85}
              >
                <View
                  style={[
                    styles.checkbox,
                    item.completed && { backgroundColor: USC_CARDINAL, borderColor: USC_CARDINAL },
                  ]}
                >
                  {item.completed ? <Text style={styles.checkboxCheck}>✓</Text> : null}
                </View>
                <Text style={styles.assignmentLabel}>
                  {item.completed ? 'Completed' : 'Mark complete'}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={[styles.eventTypeText, { color }]}>{getEventTypeLabel(item.type)}</Text>
            )}
          </View>
        </View>
      </SwipeToDeleteRow>
    );
  };

  const dayTimelineData = useMemo(() => {
    const scheduled: Array<UscEvent & { startMin: number; endMin: number }> = [];
    const unscheduled: UscEvent[] = [];
    for (const ev of selectedDateEvents) {
      const startMin = parseTimeToMinutes(ev.startTime);
      const endMin = parseTimeToMinutes(ev.endTime);
      if (startMin == null || endMin == null) unscheduled.push(ev);
      else scheduled.push({ ...ev, startMin, endMin });
    }
    scheduled.sort((a, b) => a.startMin - b.startMin);
    return { scheduled, unscheduled };
  }, [selectedDateEvents]);

  useEffect(() => {
    if (viewMode !== 'week' || dayDetailMode !== 'timeline') return;
    // Auto-scroll to 7 AM (like Google Calendar) after layout.
    const hourHeight = 64;
    const targetY = 7 * hourHeight;
    const t = setTimeout(() => {
      timelineScrollRef.current?.scrollTo({ y: targetY, animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [viewMode, dayDetailMode, selectedDateKey]);

  const renderTimeline = () => {
    const DAY_START_MIN = 0;
    const DAY_END_MIN = 24 * 60;
    const hourHeight = 64; // px per hour
    const pxPerMin = hourHeight / 60;
    const totalHeight = (DAY_END_MIN - DAY_START_MIN) * pxPerMin;

    const hours = [];
    for (let h = 0; h <= 23; h++) hours.push(h);

    return (
      <ScrollView
        ref={(r) => {
          timelineScrollRef.current = r;
        }}
        style={styles.timelineScroll}
        contentContainerStyle={styles.timelineContent}
      >
        <View style={[styles.timelineWrap, { height: totalHeight }]}>
          <View style={styles.timelineAxis}>
            {hours.map((h) => (
              <View key={h} style={[styles.timelineHourRow, { height: hourHeight }]}>
                <Text style={styles.timelineHourLabel}>
                  {h === 12 ? '12 PM' : h === 0 ? '12 AM' : h < 12 ? `${h} AM` : `${h - 12} PM`}
                </Text>
                <View style={styles.timelineHourLine} />
              </View>
            ))}
          </View>

          <View style={[styles.timelineLane, { height: totalHeight }]}>
            {dayTimelineData.scheduled.map((ev) => {
              const color = getColorForEventType(ev.type);
              const start = Math.max(0, Math.min(DAY_END_MIN, ev.startMin));
              const end = Math.max(0, Math.min(DAY_END_MIN, ev.endMin));
              const normalizedEnd = end > start ? end : start + 60;
              const duration = Math.max(60, normalizedEnd - start); // 1 hour minimum
              const top = (start - DAY_START_MIN) * pxPerMin;
              const height = duration * pxPerMin;
              const clampedTop = Math.min(Math.max(0, top), Math.max(0, totalHeight - height));
              return (
                <View
                  key={ev.id}
                  style={[
                    styles.timelineBlock,
                    {
                      top: clampedTop,
                      height,
                      borderLeftColor: color,
                      backgroundColor:
                        ev.type === 'class'
                          ? 'rgba(0,122,255,0.12)'
                          : ev.type === 'event'
                            ? 'rgba(52,199,89,0.12)'
                            : 'rgba(153,0,0,0.14)',
                    },
                  ]}
                >
                  <Text style={styles.timelineBlockTitle} numberOfLines={2}>
                    {ev.title}
                  </Text>
                  <Text style={styles.timelineBlockLoc} numberOfLines={1}>
                    {ev.startTime} – {ev.endTime}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        <View style={styles.unscheduledSection}>
          <Text style={styles.unscheduledTitle}>Unscheduled</Text>
          {dayTimelineData.unscheduled.length === 0 ? (
            <Text style={styles.unscheduledEmpty}>No unscheduled items.</Text>
          ) : (
            dayTimelineData.unscheduled.map((ev) => {
              const color = getColorForEventType(ev.type);
              return (
                <SwipeToDeleteRow key={ev.id} onDelete={() => deleteEventById(ev.id)}>
                  <View style={styles.unscheduledCard}>
                    <View style={[styles.cardLeftBorder, { backgroundColor: color }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>{ev.title}</Text>
                      <Text style={styles.cardMeta}>{ev.location ? ev.location : 'Location TBA'}</Text>
                      {ev.type === 'assignment' ? (
                        <TouchableOpacity
                          style={styles.assignmentRow}
                          onPress={() => toggleAssignmentCompleted(ev.id)}
                          activeOpacity={0.85}
                        >
                          <View
                            style={[
                              styles.checkbox,
                              ev.completed && { backgroundColor: USC_CARDINAL, borderColor: USC_CARDINAL },
                            ]}
                          >
                            {ev.completed ? <Text style={styles.checkboxCheck}>✓</Text> : null}
                          </View>
                          <Text style={styles.assignmentLabel}>
                            {ev.completed ? 'Completed' : 'Mark complete'}
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <Text style={[styles.eventTypeText, { color }]}>
                          {getEventTypeLabel(ev.type)}
                        </Text>
                      )}
                    </View>
                  </View>
                </SwipeToDeleteRow>
              );
            })
          )}
        </View>
      </ScrollView>
    );
  };

  const renderMonthDayCell = (dateKey: string, inMonth: boolean, isSelected: boolean) => {
    const dt = parseDateKey(dateKey);
    if (!dt) return null;
    const dayNumber = dt.getDate();

    const eventsOnDay = events.filter((e) => e.date === dateKey);
    const hasClass = eventsOnDay.some((e) => e.type === 'class');
    const hasEvent = eventsOnDay.some((e) => e.type === 'event');
    const hasAssignment = eventsOnDay.some((e) => e.type === 'assignment');

    const dots: { key: string; color: string }[] = [];
    if (hasClass) dots.push({ key: 'class', color: getColorForEventType('class') });
    if (hasEvent) dots.push({ key: 'event', color: getColorForEventType('event') });
    if (hasAssignment) dots.push({ key: 'assignment', color: getColorForEventType('assignment') });

    return (
      <Pressable
        key={dateKey}
        style={[
          styles.monthCell,
          !inMonth && { opacity: 0.45 },
          isSelected && { borderColor: USC_CARDINAL, borderWidth: 1 },
        ]}
        onPress={() => handleSelectDayFromMonth(dateKey)}
      >
        <Text
          style={[
            styles.monthCellDayText,
            isSelected && { color: '#ffffff', fontWeight: '800' },
          ]}
        >
          {dayNumber}
        </Text>
        <View style={styles.monthDotsRow}>
          {dots.slice(0, 3).map((d) => (
            <View key={d.key} style={[styles.monthDot, { backgroundColor: d.color }]} />
          ))}
        </View>
      </Pressable>
    );
  };

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>USC Companion</Text>
        <Text style={styles.headerSubtitle}>
          {viewMode === 'week' ? 'Your week at a glance' : 'Plan the month ahead'}
        </Text>
      </View>

      <View style={styles.controlArea}>
        <View style={styles.assignmentsQuickRow}>
          <TouchableOpacity
            style={styles.assignmentsQuickCard}
            onPress={onOpenAssignments}
            activeOpacity={0.9}
          >
            <View style={styles.assignmentsQuickLeftBar} />
            <Text style={styles.assignmentsQuickTitle}>Assignments</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.segmented}>
          <TouchableOpacity
            style={[styles.segment, viewMode === 'week' && { backgroundColor: USC_CARDINAL }]}
            onPress={() => setViewMode('week')}
          >
            <Text style={[styles.segmentText, viewMode === 'week' && { color: '#fff' }]}>Week</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segment, viewMode === 'month' && { backgroundColor: USC_CARDINAL }]}
            onPress={() => setViewMode('month')}
          >
            <Text style={[styles.segmentText, viewMode === 'month' && { color: '#fff' }]}>Month</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.navRow}>
          <TouchableOpacity
            style={styles.navButton}
            onPress={() => handlePrevNext(-1)}
            activeOpacity={0.85}
          >
            <Text style={styles.navButtonText}>{'‹'}</Text>
          </TouchableOpacity>
          <Text style={styles.navTitle}>{viewMode === 'week' ? formatWeekTitle(weekStart) : formatMonthTitle(monthCursor)}</Text>
          <TouchableOpacity
            style={styles.navButton}
            onPress={() => handlePrevNext(1)}
            activeOpacity={0.85}
          >
            <Text style={styles.navButtonText}>{'›'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {viewMode === 'week' ? (
        <View style={styles.weekSection}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.weekScroll}
          >
            {weekDays.map((day) => {
              const isSelected = day.dateKey === selectedDateKey;
              const pct = getAssignmentProgressForDay(day.dateKey);
              return (
                <TouchableOpacity
                  key={day.dateKey}
                  style={[
                    styles.dayChip,
                    isSelected && { backgroundColor: USC_CARDINAL, borderColor: USC_CARDINAL },
                  ]}
                  onPress={() => setSelectedDateKey(day.dateKey)}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.dayChipLetter, isSelected && { color: '#ffffff' }]}>
                    {day.label}
                  </Text>
                  <Text style={[styles.dayChipDate, isSelected && { color: '#ffffff' }]}>
                    {day.dayNumber}
                  </Text>
                  <View style={{ marginTop: 8, width: '100%' }}>
                    <ThinProgressBar percent={pct} />
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.listHeader}>
            <Text style={styles.listTitle}>
              {parseDateKey(selectedDateKey)
                ? parseDateKey(selectedDateKey)!.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
                : selectedDateKey}
            </Text>
            <Text style={styles.listSubtitle}>
              {itemsForSelectedDayEmpty
                ? 'No items yet. Tap + to add.'
                : `${selectedDateEvents.length} item${selectedDateEvents.length === 1 ? '' : 's'} scheduled`}
            </Text>
          </View>

          <View style={styles.dayDetailToggleRow}>
            <View style={styles.dayDetailSegmented}>
              <TouchableOpacity
                style={[
                  styles.dayDetailSegment,
                  dayDetailMode === 'list' && { backgroundColor: USC_CARDINAL },
                ]}
                onPress={() => setDayDetailMode('list')}
              >
                <Text
                  style={[
                    styles.dayDetailSegmentText,
                    dayDetailMode === 'list' && { color: '#fff' },
                  ]}
                >
                  List
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.dayDetailSegment,
                  dayDetailMode === 'timeline' && { backgroundColor: USC_CARDINAL },
                ]}
                onPress={() => setDayDetailMode('timeline')}
              >
                <Text
                  style={[
                    styles.dayDetailSegmentText,
                    dayDetailMode === 'timeline' && { color: '#fff' },
                  ]}
                >
                  Timeline
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {dayDetailMode === 'list' ? (
            <FlatList
              data={selectedDateEvents}
              keyExtractor={(it) => it.id}
              renderItem={renderEventCard}
              contentContainerStyle={
                itemsForSelectedDayEmpty ? styles.listContentEmpty : styles.listContent
              }
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>Nothing planned yet.</Text>
                  <Text style={styles.emptySubtitle}>
                    Stay ahead by adding classes, events, and assignments.
                  </Text>
                </View>
              }
            />
          ) : (
            renderTimeline()
          )}
        </View>
      ) : (
        <View style={styles.monthSection}>
          <View style={styles.weekdayHeaderRow}>
            {weekdayLabels.map((w) => (
              <Text key={w} style={styles.weekdayHeader}>
                {w.slice(0, 1)}
              </Text>
            ))}
          </View>
          <View style={styles.monthGrid}>
            {monthGrid.map((day) => {
              const isSelected = day.dateKey === selectedDateKey;
              return renderMonthDayCell(day.dateKey, day.inMonth, isSelected);
            })}
          </View>

          <View style={styles.monthSelectedSummary}>
            <Text style={styles.monthSelectedText}>
              Selected: {selectedDateKey}
            </Text>
            <Text style={styles.monthSelectedHint}>Tap + to add an item on this date.</Text>
          </View>
        </View>
      )}

      <TouchableOpacity style={styles.fab} onPress={openAddModal} activeOpacity={0.9}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add item</Text>

            <Text style={styles.modalLabel}>Title</Text>
            <TextInput
              value={newTitle}
              onChangeText={setNewTitle}
              placeholder="e.g. CSCI 201 Lecture"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
              autoCapitalize="sentences"
            />

            <Text style={styles.modalLabel}>Type</Text>
            <View style={styles.modalChipsRow}>
              {(['class', 'event', 'assignment'] as EventType[]).map((t) => {
                const active = newType === t;
                return (
                  <TouchableOpacity
                    key={t}
                    onPress={() => setNewType(t)}
                    style={[styles.modalChip, active && { backgroundColor: getColorForEventType(t), borderColor: getColorForEventType(t) }]}
                    activeOpacity={0.9}
                  >
                    <Text style={[styles.modalChipText, active && { color: '#fff' }]}>
                      {getEventTypeLabel(t)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.modalLabel}>Date (YYYY-MM-DD)</Text>
            <TextInput
              value={newDate}
              onChangeText={setNewDate}
              placeholder="2026-03-17"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
            />

            <Text style={styles.modalLabel}>Start time (HH:MM)</Text>
            <TextInput
              value={newStartTime}
              onChangeText={setNewStartTime}
              placeholder="10:00"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
            />

            <Text style={styles.modalLabel}>End time (HH:MM)</Text>
            <TextInput
              value={newEndTime}
              onChangeText={setNewEndTime}
              placeholder="11:00"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
            />

            <Text style={styles.modalLabel}>Location</Text>
            <TextInput
              value={newLocation}
              onChangeText={setNewLocation}
              placeholder="e.g. SAL 101"
              placeholderTextColor="rgba(255,255,255,0.35)"
              style={styles.modalInput}
            />

            <Text style={styles.modalLabel}>Repeat</Text>
            <View style={styles.modalChipsRow}>
              {(['none', 'daily', 'weekly', 'MWF', 'TuTh', 'MW'] as RepeatRule[]).map((r) => {
                const active = newRepeat === r;
                const chipColor =
                  r === 'none' ? 'rgba(255,255,255,0.12)' : USC_GOLD;
                return (
                  <TouchableOpacity
                    key={r}
                    onPress={() => setNewRepeat(r)}
                    style={[
                      styles.modalChip,
                      active && {
                        backgroundColor: USC_CARDINAL,
                        borderColor: USC_CARDINAL,
                      },
                    ]}
                    activeOpacity={0.9}
                  >
                    <Text style={[styles.modalChipText, active && { color: '#fff' }]}>
                      {r === 'none' ? 'None' : r}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {newRepeat !== 'none' ? (
              <>
                <Text style={styles.modalLabel}>Repeat until (YYYY-MM-DD)</Text>
                <TextInput
                  value={newRepeatUntil}
                  onChangeText={setNewRepeatUntil}
                  placeholder="2026-04-30"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={styles.modalInput}
                />
              </>
            ) : null}

            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={[styles.modalSecondaryButton]}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalPrimaryButton}
                onPress={() => {
                  if (!newTitle.trim()) return;
                  const dateKeyOk = isValidDateKey(newDate);
                  const untilOk = newRepeat === 'none' ? true : isValidDateKey(newRepeatUntil);
                  if (!dateKeyOk) return;
                  if (!untilOk) return;
                  const startMin = parseTimeToMinutes(newStartTime);
                  const endMin = parseTimeToMinutes(newEndTime);
                  if (startMin == null || endMin == null) return;
                  if (endMin <= startMin) return;
                  addEvents({
                    title: newTitle,
                    type: newType,
                    date: newDate,
                    startTime: newStartTime,
                    endTime: newEndTime,
                    location: newLocation,
                    repeat: newRepeat,
                    repeatUntil: newRepeat === 'none' ? newDate : newRepeatUntil,
                  });
                }}
              >
                <Text style={styles.modalPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>

            {loading ? null : (
              <Text style={styles.modalHint}>
                Recurring items are expanded into individual instances up to `repeatUntil`.
              </Text>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0b',
  },
  header: {
    backgroundColor: USC_CARDINAL,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#ffffff',
    opacity: 0.9,
    marginTop: 4,
  },
  controlArea: {
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  assignmentsQuickRow: {
    marginBottom: 12,
  },
  assignmentsQuickCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141414',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  assignmentsQuickLeftBar: {
    width: 6,
    height: 28,
    borderRadius: 6,
    backgroundColor: USC_CARDINAL,
    marginRight: 12,
  },
  assignmentsQuickTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 15,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: {
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '700',
    fontSize: 13,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
  },
  navButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  navButtonText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '800',
  },
  navTitle: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
    opacity: 0.95,
    textAlign: 'center',
    flex: 1,
  },
  weekSection: {
    paddingTop: 12,
    flex: 1,
  },
  weekScroll: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dayChip: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    width: 66,
    marginRight: 10,
    alignItems: 'center',
  },
  dayChipLetter: {
    color: 'rgba(255,255,255,0.9)',
    fontWeight: '900',
    fontSize: 14,
  },
  dayChipDate: {
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '800',
    fontSize: 16,
    marginTop: 2,
  },
  thinBarBg: {
    height: 4,
    width: '100%',
    borderRadius: 3,
    backgroundColor: '#2c2c2c',
    overflow: 'hidden',
  },
  thinBarFill: {
    height: 4,
    backgroundColor: USC_GOLD,
    borderRadius: 3,
  },
  listHeader: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 10,
  },
  dayDetailToggleRow: {
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  dayDetailSegmented: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  dayDetailSegment: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayDetailSegmentText: {
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '800',
    fontSize: 13,
  },
  listTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 16,
  },
  listSubtitle: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 110,
  },
  listContentEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingBottom: 110,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  emptyTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  emptySubtitle: {
    marginTop: 6,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    lineHeight: 18,
  },
  card: {
    flexDirection: 'row',
    borderRadius: 16,
    backgroundColor: '#141414',
    marginVertical: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  swipeRowOuter: {
    position: 'relative',
  },
  deleteUnderlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#D81E1E',
    borderRadius: 16,
    marginVertical: 6,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8 as any,
  },
  deleteUnderlayIcon: {
    fontSize: 18,
  },
  deleteUnderlayText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  cardLeftBorder: {
    width: 6,
    borderRadius: 8,
    marginRight: 12,
  },
  cardBody: {
    flex: 1,
  },
  cardTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 4,
  },
  cardMeta: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  eventTypeText: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: '900',
  },
  assignmentRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  checkboxCheck: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 15,
  },
  assignmentLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '700',
  },
  fab: {
    position: 'absolute',
    right: 22,
    bottom: 42,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: USC_CARDINAL,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  fabText: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '900',
    marginTop: -4,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#121212',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  modalTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 18,
    marginBottom: 10,
  },
  modalLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '800',
    fontSize: 13,
    marginTop: 10,
    marginBottom: 6,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: '#0f0f0f',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 14,
  },
  modalChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  modalChip: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
    marginBottom: 8,
  },
  modalChipText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '800',
  },
  modalButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalSecondaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    marginRight: 10,
  },
  modalSecondaryText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  modalPrimaryButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: USC_CARDINAL,
    borderWidth: 1,
    borderColor: USC_CARDINAL,
  },
  modalPrimaryText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  modalHint: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    lineHeight: 18,
  },
  monthSection: {
    paddingTop: 12,
    paddingHorizontal: 14,
    flex: 1,
  },
  weekdayHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
  weekdayHeader: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '900',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: 14,
  },
  monthCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: 6,
    marginRight: 0,
    paddingTop: 6,
    paddingHorizontal: 6,
  },
  monthCellDayText: {
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '900',
    fontSize: 13,
  },
  monthDotsRow: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  monthDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginHorizontal: 2,
  },
  monthSelectedSummary: {
    paddingTop: 14,
    paddingBottom: 100,
  },
  monthSelectedText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  monthSelectedHint: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  timelineScroll: {
    flex: 1,
    minHeight: 540,
  },
  timelineContent: {
    paddingHorizontal: 14,
    paddingBottom: 110,
  },
  timelineWrap: {
    position: 'relative',
    width: '100%',
  },
  timelineAxis: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    paddingRight: 8,
    zIndex: 1,
  },
  timelineHourRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  timelineHourLabel: {
    width: 60,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: '900',
    fontSize: 12,
    paddingTop: 2,
  },
  timelineHourLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginTop: 8,
  },
  timelineLane: {
    position: 'absolute',
    left: 60,
    right: 0,
    top: 0,
    zIndex: 2,
  },
  timelineBlock: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderLeftWidth: 6,
  },
  timelineBlockTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  timelineBlockLoc: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '700',
    fontSize: 12,
  },
  unscheduledSection: {
    marginTop: 20,
  },
  unscheduledTitle: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 16,
    marginBottom: 10,
  },
  unscheduledEmpty: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },
  unscheduledCard: {
    flexDirection: 'row',
    borderRadius: 16,
    backgroundColor: '#141414',
    marginVertical: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
});

