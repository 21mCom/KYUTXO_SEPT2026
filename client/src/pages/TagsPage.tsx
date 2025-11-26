import { useState } from "react";
import { Plus, Tag, FolderOpen, Edit, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const mockTags = [
  { id: "1", name: "cold-storage", count: 5, color: "blue" },
  { id: "2", name: "hot-wallet", count: 12, color: "orange" },
  { id: "3", name: "exchange", count: 8, color: "green" },
  { id: "4", name: "savings", count: 3, color: "purple" },
];

const mockCategories = [
  { id: "1", name: "Personal", count: 15 },
  { id: "2", name: "Business", count: 7 },
  { id: "3", name: "Trading", count: 10 },
];

export default function TagsPage() {
  const [newTag, setNewTag] = useState("");
  const [newCategory, setNewCategory] = useState("");

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Tags & Categories</h1>
          <p className="text-muted-foreground">
            Manage custom vocabularies for organizing your Bitcoin records
          </p>
        </div>

        <Tabs defaultValue="tags">
          <TabsList>
            <TabsTrigger value="tags" data-testid="tab-tags">
              <Tag className="h-4 w-4 mr-2" />
              Tags
            </TabsTrigger>
            <TabsTrigger value="categories" data-testid="tab-categories">
              <FolderOpen className="h-4 w-4 mr-2" />
              Categories
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tags" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Add New Tag</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    placeholder="Tag name"
                    data-testid="input-new-tag"
                  />
                  <Button onClick={() => {
                    console.log("Add tag:", newTag);
                    setNewTag("");
                  }} data-testid="button-add-tag">
                    <Plus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4">
              {mockTags.map((tag) => (
                <Card key={tag.id} className="hover-elevate" data-testid={`card-tag-${tag.id}`}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Tag className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <h3 className="font-semibold">{tag.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          Used in {tag.count} records
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" data-testid={`button-edit-${tag.id}`}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" data-testid={`button-delete-${tag.id}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="categories" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Add New Category</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="Category name"
                    data-testid="input-new-category"
                  />
                  <Button onClick={() => {
                    console.log("Add category:", newCategory);
                    setNewCategory("");
                  }} data-testid="button-add-category">
                    <Plus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4">
              {mockCategories.map((category) => (
                <Card key={category.id} className="hover-elevate" data-testid={`card-category-${category.id}`}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <FolderOpen className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <h3 className="font-semibold">{category.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {category.count} records
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" data-testid={`button-edit-cat-${category.id}`}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" data-testid={`button-delete-cat-${category.id}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
