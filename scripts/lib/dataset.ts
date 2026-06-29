export interface Dataset {
  id: string;

  name: string;

  description: string;

  filename: string;

  url: string;

  size: string;

  category: string;

  recommended: boolean;
}

export interface DatasetRegistry {
  version: number;

  datasets: Dataset[];
}
