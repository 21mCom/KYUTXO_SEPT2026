import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { 
  ChartContainer, 
  ChartTooltip, 
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent 
} from "@/components/ui/chart";
import { 
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip
} from "recharts";
import { 
  AlertCircle, Check, Copy, Info, Plus, Search, Settings, 
  ChevronRight, Download, Upload, Trash2, Edit, Eye
} from "lucide-react";
import { SiBitcoin } from "react-icons/si";

const sampleChartData = [
  { name: "Jan", value: 400, secondary: 240 },
  { name: "Feb", value: 300, secondary: 139 },
  { name: "Mar", value: 520, secondary: 380 },
  { name: "Apr", value: 278, secondary: 390 },
  { name: "May", value: 189, secondary: 480 },
  { name: "Jun", value: 439, secondary: 320 },
];

const pieData = [
  { name: "BTC", value: 400 },
  { name: "Lightning", value: 300 },
  { name: "Other", value: 200 },
];

const COLORS = ["hsl(var(--primary))", "hsl(var(--secondary))", "hsl(var(--muted))"];

export default function UIAssets() {
  const [progress, setProgress] = useState(65);
  const [sliderValue, setSliderValue] = useState([50]);

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-8 max-w-6xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold" data-testid="text-page-title">UI Assets Reference</h1>
          <p className="text-muted-foreground">
            Component reference with official names. Reference any component using its ID.
          </p>
        </div>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Buttons</h2>
          <p className="text-sm text-muted-foreground">Use: "Button Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-1: Default</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button data-testid="btn-default">Default</Button>
                <code className="text-xs block text-muted-foreground">variant="default"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-2: Secondary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button variant="secondary" data-testid="btn-secondary">Secondary</Button>
                <code className="text-xs block text-muted-foreground">variant="secondary"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-3: Outline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button variant="outline" data-testid="btn-outline">Outline</Button>
                <code className="text-xs block text-muted-foreground">variant="outline"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-4: Ghost</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button variant="ghost" data-testid="btn-ghost">Ghost</Button>
                <code className="text-xs block text-muted-foreground">variant="ghost"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-5: Destructive</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button variant="destructive" data-testid="btn-destructive">Destructive</Button>
                <code className="text-xs block text-muted-foreground">variant="destructive"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-6: Icon</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex gap-2">
                  <Button size="icon" data-testid="btn-icon-default"><Plus /></Button>
                  <Button size="icon" variant="outline" data-testid="btn-icon-outline"><Settings /></Button>
                  <Button size="icon" variant="ghost" data-testid="btn-icon-ghost"><Search /></Button>
                </div>
                <code className="text-xs block text-muted-foreground">size="icon"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-7: With Icon</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button data-testid="btn-with-icon"><Download className="mr-2 h-4 w-4" /> Download</Button>
                <code className="text-xs block text-muted-foreground">Icon + text</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BTN-8: Sizes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button size="sm" data-testid="btn-sm">Small</Button>
                  <Button size="default" data-testid="btn-md">Default</Button>
                  <Button size="lg" data-testid="btn-lg">Large</Button>
                </div>
                <code className="text-xs block text-muted-foreground">size="sm|default|lg"</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Badges</h2>
          <p className="text-sm text-muted-foreground">Use: "Badge Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BDG-1: Default</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge data-testid="badge-default">Default</Badge>
                <code className="text-xs block text-muted-foreground">variant="default"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BDG-2: Secondary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant="secondary" data-testid="badge-secondary">Secondary</Badge>
                <code className="text-xs block text-muted-foreground">variant="secondary"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BDG-3: Outline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant="outline" data-testid="badge-outline">Outline</Badge>
                <code className="text-xs block text-muted-foreground">variant="outline"</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">BDG-4: Destructive</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant="destructive" data-testid="badge-destructive">Destructive</Badge>
                <code className="text-xs block text-muted-foreground">variant="destructive"</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Inputs</h2>
          <p className="text-sm text-muted-foreground">Use: "Input Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">INP-1: Text Input</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Input placeholder="Enter text..." data-testid="input-text" />
                <code className="text-xs block text-muted-foreground">&lt;Input /&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">INP-2: With Label</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="labeled">Label</Label>
                  <Input id="labeled" placeholder="With label" data-testid="input-labeled" />
                </div>
                <code className="text-xs block text-muted-foreground">&lt;Label&gt; + &lt;Input&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">INP-3: Search</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-8" placeholder="Search..." data-testid="input-search" />
                </div>
                <code className="text-xs block text-muted-foreground">Icon + Input</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">INP-4: Textarea</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Textarea placeholder="Enter notes..." data-testid="input-textarea" />
                <code className="text-xs block text-muted-foreground">&lt;Textarea /&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">INP-5: Disabled</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Input disabled placeholder="Disabled" data-testid="input-disabled" />
                <code className="text-xs block text-muted-foreground">disabled</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Selects & Dropdowns</h2>
          <p className="text-sm text-muted-foreground">Use: "Select Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">SEL-1: Basic Select</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Select>
                  <SelectTrigger data-testid="select-basic">
                    <SelectValue placeholder="Select option" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opt1">Option 1</SelectItem>
                    <SelectItem value="opt2">Option 2</SelectItem>
                    <SelectItem value="opt3">Option 3</SelectItem>
                  </SelectContent>
                </Select>
                <code className="text-xs block text-muted-foreground">&lt;Select&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">SEL-2: With Label</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="space-y-1">
                  <Label>Category</Label>
                  <Select>
                    <SelectTrigger data-testid="select-labeled">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cat1">Category A</SelectItem>
                      <SelectItem value="cat2">Category B</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <code className="text-xs block text-muted-foreground">Label + Select</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Toggles & Checkboxes</h2>
          <p className="text-sm text-muted-foreground">Use: "Toggle Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">TOG-1: Switch</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  <Switch id="switch1" data-testid="toggle-switch" />
                  <Label htmlFor="switch1">Enable</Label>
                </div>
                <code className="text-xs block text-muted-foreground">&lt;Switch&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">TOG-2: Checkbox</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox id="check1" data-testid="toggle-checkbox" />
                  <Label htmlFor="check1">Accept terms</Label>
                </div>
                <code className="text-xs block text-muted-foreground">&lt;Checkbox&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">TOG-3: Radio Group</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <RadioGroup defaultValue="opt1" data-testid="toggle-radio">
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="opt1" id="r1" />
                    <Label htmlFor="r1">Option 1</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="opt2" id="r2" />
                    <Label htmlFor="r2">Option 2</Label>
                  </div>
                </RadioGroup>
                <code className="text-xs block text-muted-foreground">&lt;RadioGroup&gt;</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Cards</h2>
          <p className="text-sm text-muted-foreground">Use: "Card Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card data-testid="card-basic">
              <CardHeader>
                <CardTitle className="text-sm">CRD-1: Basic Card</CardTitle>
                <CardDescription>Simple card with header</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm">Card content goes here.</p>
              </CardContent>
            </Card>

            <Card data-testid="card-with-footer">
              <CardHeader>
                <CardTitle className="text-sm">CRD-2: With Footer</CardTitle>
                <CardDescription>Card with footer actions</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm">Content with actions below.</p>
              </CardContent>
              <CardFooter className="gap-2">
                <Button size="sm">Save</Button>
                <Button size="sm" variant="outline">Cancel</Button>
              </CardFooter>
            </Card>

            <Card className="hover-elevate cursor-pointer" data-testid="card-interactive">
              <CardHeader>
                <CardTitle className="text-sm">CRD-3: Interactive</CardTitle>
                <CardDescription>Hover to see elevation</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm">Clickable card with hover effect.</p>
              </CardContent>
            </Card>

            <Card data-testid="card-stat">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-2">
                <CardTitle className="text-sm font-medium">CRD-4: Stat Card</CardTitle>
                <SiBitcoin className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">1.234 BTC</div>
                <p className="text-xs text-muted-foreground">+20.1% from last month</p>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Progress & Sliders</h2>
          <p className="text-sm text-muted-foreground">Use: "Progress Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">PRG-1: Progress Bar</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Progress value={progress} data-testid="progress-bar" />
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setProgress(Math.max(0, progress - 10))}>-10</Button>
                  <Button size="sm" variant="outline" onClick={() => setProgress(Math.min(100, progress + 10))}>+10</Button>
                </div>
                <code className="text-xs block text-muted-foreground">&lt;Progress value=&#123;{progress}&#125; /&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">PRG-2: Slider</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Slider 
                  value={sliderValue} 
                  onValueChange={setSliderValue}
                  max={100}
                  step={1}
                  data-testid="slider"
                />
                <p className="text-sm text-muted-foreground">Value: {sliderValue[0]}</p>
                <code className="text-xs block text-muted-foreground">&lt;Slider&gt;</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Alerts</h2>
          <p className="text-sm text-muted-foreground">Use: "Alert Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Alert data-testid="alert-default">
              <Info className="h-4 w-4" />
              <AlertTitle>ALT-1: Default Alert</AlertTitle>
              <AlertDescription>
                This is an informational message.
              </AlertDescription>
            </Alert>

            <Alert variant="destructive" data-testid="alert-destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>ALT-2: Destructive Alert</AlertTitle>
              <AlertDescription>
                This is a warning or error message.
              </AlertDescription>
            </Alert>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Tabs</h2>
          <p className="text-sm text-muted-foreground">Use: "Tabs Style [ID]"</p>
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">TAB-1: Default Tabs</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="tab1" data-testid="tabs-default">
                <TabsList>
                  <TabsTrigger value="tab1">Overview</TabsTrigger>
                  <TabsTrigger value="tab2">Details</TabsTrigger>
                  <TabsTrigger value="tab3">Settings</TabsTrigger>
                </TabsList>
                <TabsContent value="tab1" className="p-4">
                  Overview content here.
                </TabsContent>
                <TabsContent value="tab2" className="p-4">
                  Details content here.
                </TabsContent>
                <TabsContent value="tab3" className="p-4">
                  Settings content here.
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Avatars</h2>
          <p className="text-sm text-muted-foreground">Use: "Avatar Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">AVT-1: With Image</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Avatar data-testid="avatar-image">
                  <AvatarFallback>CN</AvatarFallback>
                </Avatar>
                <code className="text-xs block text-muted-foreground">&lt;Avatar&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">AVT-2: Fallback</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Avatar data-testid="avatar-fallback">
                  <AvatarFallback>BT</AvatarFallback>
                </Avatar>
                <code className="text-xs block text-muted-foreground">&lt;AvatarFallback&gt;</code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">AVT-3: Sizes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  <Avatar className="h-6 w-6"><AvatarFallback className="text-xs">SM</AvatarFallback></Avatar>
                  <Avatar><AvatarFallback>MD</AvatarFallback></Avatar>
                  <Avatar className="h-12 w-12"><AvatarFallback>LG</AvatarFallback></Avatar>
                </div>
                <code className="text-xs block text-muted-foreground">h-6/default/h-12</code>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Charts</h2>
          <p className="text-sm text-muted-foreground">Use: "Chart Style [ID]"</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CHT-1: Line Chart</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48" data-testid="chart-line">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sampleChartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" className="text-xs" />
                      <YAxis className="text-xs" />
                      <RechartsTooltip />
                      <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CHT-2: Area Chart</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48" data-testid="chart-area">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={sampleChartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" className="text-xs" />
                      <YAxis className="text-xs" />
                      <RechartsTooltip />
                      <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.3)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CHT-3: Bar Chart</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48" data-testid="chart-bar">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={sampleChartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" className="text-xs" />
                      <YAxis className="text-xs" />
                      <RechartsTooltip />
                      <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CHT-4: Pie Chart</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48" data-testid="chart-pie">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={40}
                        outerRadius={60}
                        dataKey="value"
                        label={({ name }) => name}
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CHT-5: Multi-Series</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48" data-testid="chart-multi">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={sampleChartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" className="text-xs" />
                      <YAxis className="text-xs" />
                      <RechartsTooltip />
                      <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="secondary" fill="hsl(var(--secondary))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CHT-6: Stacked Area</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48" data-testid="chart-stacked">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={sampleChartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="name" className="text-xs" />
                      <YAxis className="text-xs" />
                      <RechartsTooltip />
                      <Area type="monotone" dataKey="value" stackId="1" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.5)" />
                      <Area type="monotone" dataKey="secondary" stackId="1" stroke="hsl(var(--secondary))" fill="hsl(var(--secondary) / 0.5)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Icons (Common)</h2>
          <p className="text-sm text-muted-foreground">Use: "Icon [Name]" - from lucide-react</p>
          
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-wrap gap-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Plus className="h-5 w-5" />
                      <span className="text-xs">Plus</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Add/Create</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Edit className="h-5 w-5" />
                      <span className="text-xs">Edit</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Modify</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Trash2 className="h-5 w-5" />
                      <span className="text-xs">Trash2</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Search className="h-5 w-5" />
                      <span className="text-xs">Search</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Search</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Settings className="h-5 w-5" />
                      <span className="text-xs">Settings</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Configure</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Download className="h-5 w-5" />
                      <span className="text-xs">Download</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Export</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Upload className="h-5 w-5" />
                      <span className="text-xs">Upload</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Import</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Copy className="h-5 w-5" />
                      <span className="text-xs">Copy</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Copy</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Check className="h-5 w-5" />
                      <span className="text-xs">Check</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Confirm</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Eye className="h-5 w-5" />
                      <span className="text-xs">Eye</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>View</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <ChevronRight className="h-5 w-5" />
                      <span className="text-xs">ChevronRight</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Navigate</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <Info className="h-5 w-5" />
                      <span className="text-xs">Info</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Information</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <AlertCircle className="h-5 w-5" />
                      <span className="text-xs">AlertCircle</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Warning</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex flex-col items-center gap-1 p-2 rounded hover-elevate cursor-pointer">
                      <SiBitcoin className="h-5 w-5" />
                      <span className="text-xs">SiBitcoin</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Bitcoin logo (react-icons)</TooltipContent>
                </Tooltip>
              </div>
            </CardContent>
          </Card>
        </section>

        <div className="h-8" />
      </div>
    </ScrollArea>
  );
}
