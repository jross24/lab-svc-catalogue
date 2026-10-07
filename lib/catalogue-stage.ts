import { Stage } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { CatalogueStack } from './catalogue-stack.ts';
import type { CatalogueStackProps } from './catalogue-stack.ts';

// One deployable copy of the service. `cdk deploy "<id>/*"` deploys all the stacks of one stage.
export class CatalogueStage extends Stage {
  constructor(scope: Construct, id: string, props: CatalogueStackProps) {
    super(scope, id);
    new CatalogueStack(this, 'Catalogue', props);
  }
}
